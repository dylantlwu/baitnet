import { JsonRpcProvider } from "near-api-js";
import { classifyRpcError, parseRpcUrls, withRpcRetry, type RpcRetryOptions } from "./rpc.js";

/** HTTP statuses near-api-js reports via `ProviderError.cause` that we retry (it only retries 500/503/408 itself, never 429). */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** near-api-js errors → retry decision (no Retry-After: near-api-js consumes the response before we see it). */
export function classifyNearApiError(err: unknown): { retry: boolean } {
  const e = err as { cause?: unknown; type?: string; name?: string; message?: string };
  if (typeof e?.cause === "number" && RETRY_STATUS.has(e.cause)) return { retry: true };
  if (e?.type === "RetriesExceeded") return { retry: true };
  // send_tx that did not reach finality within the node's own timeout: resending the
  // same signed tx is how nearcore expects clients to keep waiting (same hash, no double spend)
  const kind = `${(err as object | null)?.constructor?.name ?? ""} ${e?.name ?? ""} ${e?.message ?? ""}`;
  if (/TIMEOUT_ERROR|TransactionTimeout|Timeout error|NodeIsSyncing/i.test(kind)) return { retry: true };
  return classifyRpcError(err);
}

/** Methods that may legitimately block for a while on the node (waiting for tx finality). */
const SLOW_METHODS = new Set(["send_tx", "broadcast_tx_commit", "tx", "EXPERIMENTAL_tx_status"]);

/**
 * near-api-js provider with the same retry / failover policy as the raw view
 * calls in ./rpc.ts. `rpcUrl` may be a comma-separated list. Each endpoint gets
 * an inner JsonRpcProvider with its own retries disabled; this class does the
 * retrying so 429 / 502 / network errors are retried too and endpoints rotate.
 *
 * Re-sending a signed transaction is safe: it has a fixed nonce and hash, so the
 * network executes it at most once.
 */
export class ResilientRpcProvider extends JsonRpcProvider {
  readonly urls: string[];
  private inner = new Map<string, JsonRpcProvider>();

  constructor(
    rpcUrl: string | readonly string[],
    private retry: RpcRetryOptions = {},
  ) {
    const urls = parseRpcUrls(rpcUrl);
    super({ url: urls[0] ?? "" }, { retries: 1 });
    this.urls = urls;
    for (const u of urls) this.inner.set(u, new JsonRpcProvider({ url: u }, { retries: 1 }));
  }

  // Every Provider method of JsonRpcProvider funnels through sendJsonRpc.
  override sendJsonRpc(method: any, params: any): Promise<any> {
    const slow = SLOW_METHODS.has(String(method));
    return withRpcRetry(this.urls, (url) => this.inner.get(url)!.sendJsonRpc(method, params), {
      classify: classifyNearApiError,
      ...(slow ? { totalTimeoutMs: 120_000, maxAttempts: 8, trackLatency: false } : {}),
      ...this.retry,
    });
  }
}
