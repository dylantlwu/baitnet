/**
 * Minimal NEAR JSON-RPC for read-only queries (no near-api-js needed for views),
 * plus the retry / failover policy shared with the near-api-js provider used for
 * transactions (see `ResilientRpcProvider` in ./rpc-provider.ts).
 *
 * Public RPC endpoints (rpc.testnet.near.org) rate-limit hard: HTTP 429 under
 * any real load. Every call therefore:
 *   - retries 429 / 408 / 5xx / network errors / timeouts with exponential
 *     backoff + jitter, bounded by `maxAttempts` and `totalTimeoutMs`;
 *   - honours `Retry-After` (seconds or HTTP date) when the server sends one;
 *   - fails over across several endpoints: `rpcUrl` may be a comma-separated
 *     list ("https://a,https://b"); an endpoint that just failed is cooled down
 *     and the next healthy one is tried immediately.
 */

let rpcId = 0;

/** Built-in second endpoint used when only the default public testnet RPC is configured. */
export const TESTNET_DEFAULT_RPC = "https://rpc.testnet.near.org";
export const TESTNET_FALLBACK_RPC = "https://test.rpc.fastnear.com";

/** HTTP status codes worth retrying (rate limit, timeouts, gateway/server hiccups). */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** JSON-RPC error causes that are transient on the node side. */
const RETRY_CAUSES = new Set(["TIMEOUT_ERROR", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET", "NODE_IS_SYNCING"]);

export class RpcHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RpcHttpError";
  }
}

/** JSON-RPC level error (`body.error`); `transient` ones are retried. */
export class RpcResponseError extends Error {
  constructor(
    message: string,
    readonly causeName?: string,
    readonly transient = false,
  ) {
    super(message);
    this.name = "RpcResponseError";
  }
}

export interface RpcRetryOptions {
  /** Total tries across all endpoints (default 6). */
  maxAttempts?: number;
  /** First backoff step (default 250 ms), doubled per retry. */
  baseDelayMs?: number;
  /** Cap for one backoff / Retry-After wait (default 8 s). */
  maxDelayMs?: number;
  /** Give up after this much wall time, waits included (default 30 s). */
  totalTimeoutMs?: number;
  /** Per-request timeout (default 8 s). */
  timeoutMs?: number;
  /** Decides whether an error is retryable and how long the server asked us to wait. */
  classify?: (err: unknown) => { retry: boolean; retryAfterMs?: number };
  /** Test hooks. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Never park an endpoint longer than this, whatever Retry-After says. */
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULTS = {maxAttempts: 6, baseDelayMs: 250, maxDelayMs: 8000, totalTimeoutMs: 30_000, timeoutMs: 8000 };

/**
 * Split a (possibly comma-separated) RPC setting into endpoints. A lone default
 * public testnet RPC gets a built-in fallback so one rate-limited node is not a
 * single point of failure. Set NEAR_RPC_NO_FALLBACK=1 to disable that.
 */
export function parseRpcUrls(rpcUrl: string | readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (Array.isArray(rpcUrl) ? rpcUrl : String(rpcUrl).split(","))
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const urls = [...new Set(list)];
  if (urls.length === 1 && urls[0] === TESTNET_DEFAULT_RPC && env.NEAR_RPC_NO_FALLBACK !== "1") urls.push(TESTNET_FALLBACK_RPC);
  return urls;
}

/** `Retry-After` header → milliseconds (delta-seconds or HTTP date). */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

/** Default classifier for errors coming out of `rpcCall` / fetch. */
export function classifyRpcError(err: unknown): { retry: boolean; retryAfterMs?: number } {
  if (err instanceof RpcHttpError) return { retry: RETRY_STATUS.has(err.status), retryAfterMs: err.retryAfterMs };
  if (err instanceof RpcResponseError) return { retry: err.transient };
  const e = err as { name?: string; message?: string; cause?: unknown; code?: string };
  // AbortSignal.timeout → TimeoutError; undici network failures → TypeError("fetch failed")
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { retry: true };
  const text = `${e?.message ?? ""} ${(e?.cause as { code?: string } | undefined)?.code ?? e?.code ?? ""}`;
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network/i.test(text)) return { retry: true };
  return { retry: false };
}

/** Per-endpoint cooldown shared by every caller in this process (so one 429 slows all callers down). */
const cooldownUntil = new Map<string, number>();

/** Test helper: forget endpoint cooldowns. */
export function resetRpcHealth() {
  cooldownUntil.clear();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` against the endpoints with retries + failover. `fn` gets the endpoint
 * and the per-request timeout (already clipped to the remaining total budget).
 */
export async function withRpcRetry<T>(urls: readonly string[], fn: (url: string, timeoutMs: number) => Promise<T>, opts: RpcRetryOptions = {}): Promise<T> {
  if (!urls.length) throw new Error("no NEAR RPC endpoint configured");
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const classify = opts.classify ?? classifyRpcError;
  const deadline = now() + o.totalTimeoutMs;
  let lastErr: unknown;
  let preferred = 0;

  for (let attempt = 0; attempt < o.maxAttempts; attempt++) {
    // first endpoint (in configured order, starting from `preferred`) that is not cooling down;
    // otherwise wait for the one that recovers first
    let idx = -1;
    let soonest = Infinity;
    for (let k = 0; k < urls.length; k++) {
      const i = (preferred + k) % urls.length;
      const until = cooldownUntil.get(urls[i]!) ?? 0;
      if (until <= now()) {
        idx = i;
        break;
      }
      if (until < soonest) {
        soonest = until;
        idx = i;
      }
    }
    const url = urls[idx]!;
    const wait = Math.max(0, (cooldownUntil.get(url) ?? 0) - now());
    if (wait > 0) {
      if (now() + wait >= deadline) break;
      await sleep(wait);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      const out = await fn(url, Math.min(o.timeoutMs, remaining));
      cooldownUntil.delete(url);
      return out;
    } catch (err) {
      lastErr = err;
      const c = classify(err);
      if (!c.retry) throw err;
      const backoff = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
      const jittered = backoff / 2 + random() * (backoff / 2); // "equal jitter": never 0, never in lockstep
      // Retry-After wins (plus a little jitter so callers do not stampede back together); a wait
      // longer than the remaining budget just parks this endpoint and we fail over / give up.
      const delay = c.retryAfterMs !== undefined ? Math.min(c.retryAfterMs, MAX_RETRY_AFTER_MS) + random() * o.baseDelayMs : jittered;
      cooldownUntil.set(url, now() + delay);
      preferred = (idx + 1) % urls.length; // next attempt starts with the next endpoint
      opts.log?.(`[rpc] ${url} ${(err as Error)?.message ?? err} — retry ${attempt + 1}/${o.maxAttempts - 1}${urls.length > 1 ? " (failover)" : ""} in ≥${Math.round(delay)}ms`);
    }
  }
  if (lastErr instanceof Error) {
    lastErr.message = `${lastErr.message} (gave up after retries on ${urls.join(", ")})`;
    throw lastErr;
  }
  throw new Error(`NEAR RPC: gave up after retries on ${urls.join(", ")}`);
}

/** Raw JSON-RPC call (with retries + failover). */
export async function rpcCall<T>(rpcUrl: string | readonly string[], method: string, params: unknown, opts: RpcRetryOptions | number = {}): Promise<T> {
  const o: RpcRetryOptions = typeof opts === "number" ? { timeoutMs: opts } : opts;
  return withRpcRetry(
    parseRpcUrls(rpcUrl),
    async (url, timeoutMs) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `baitnet-${++rpcId}`, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new RpcHttpError(`RPC ${method} HTTP ${res.status}`, res.status, url, parseRetryAfter(res.headers.get("retry-after")));
      }
      const body = (await res.json()) as {
        result?: T & { error?: string };
        error?: { message?: string; data?: unknown; cause?: { name?: string; info?: unknown } | unknown; name?: string };
      };
      if (body.error) {
        const causeName = (body.error.cause as { name?: string } | undefined)?.name;
        throw new RpcResponseError(`RPC ${method}: ${JSON.stringify(body.error.cause ?? body.error.data ?? body.error.message)}`, causeName, !!causeName && RETRY_CAUSES.has(causeName));
      }
      if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) {
        throw new RpcResponseError(`RPC ${method}: ${body.result.error}`);
      }
      return body.result as T;
    },
    o,
  );
}

export function rpcQuery<T>(rpcUrl: string | readonly string[], params: Record<string, unknown>, opts?: RpcRetryOptions): Promise<T> {
  return rpcCall<T>(rpcUrl, "query", params, opts);
}

export type Finality = "optimistic" | "final";

export async function viewFunction<T>(
  rpcUrl: string | readonly string[],
  contractId: string,
  methodName: string,
  args: unknown = {},
  opts: RpcRetryOptions & { finality?: Finality } = {},
): Promise<T> {
  const { finality = "optimistic", ...retry } = opts;
  const res = await rpcQuery<{ result: number[] }>(
    rpcUrl,
    {
      request_type: "call_function",
      finality,
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    retry,
  );
  const text = Buffer.from(res.result).toString("utf8");
  return (text ? JSON.parse(text) : null) as T;
}
