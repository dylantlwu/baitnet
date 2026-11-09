/**
 * Minimal Telegram Bot API client on top of fetch (no SDK; ~10 methods used).
 * The token is only ever put into request URLs; every error message is scrubbed
 * so it can never reach a log line.
 */

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfter?: number,
    readonly network = false,
  ) {
    super(message);
  }
}

export interface TelegramApiOptions {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** retries for non-polling calls (network / 5xx / 429) */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class TelegramApi {
  readonly base: string;
  private f: typeof fetch;
  private retries: number;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(private opts: TelegramApiOptions) {
    if (!opts.token || !/^\d+:[\w-]+$/.test(opts.token)) throw new TelegramError("TELEGRAM_BOT_TOKEN is malformed (expected <id>:<secret>)");
    this.base = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
    this.retries = opts.retries ?? 3;
    this.sleepFn = opts.sleep ?? ((ms) => sleep(ms));
  }

  /** Remove the token from any string (error messages, URLs). */
  scrub(s: string): string {
    return s.split(this.opts.token).join("<token>");
  }

  /** One HTTP call, no retry. */
  async raw<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}/bot${this.opts.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
    } catch (e) {
      throw new TelegramError(`${method}: network error: ${this.scrub(String((e as Error)?.message ?? e))}`, undefined, undefined, true);
    }
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError(`${method}: HTTP ${res.status} (non-JSON body)`, res.status, undefined, res.status >= 500);
    }
    if (!body.ok) throw new TelegramError(`${method}: ${this.scrub(body.description ?? `HTTP ${res.status}`)}`, body.error_code ?? res.status, body.parameters?.retry_after);
    return body.result as T;
  }

  /** With retry on network errors, 5xx and 429 (honours retry_after). */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.raw<T>(method, params);
      } catch (e) {
        const err = e as TelegramError;
        const retryable = err.network || err.code === 429 || (err.code !== undefined && err.code >= 500);
        if (!retryable || attempt >= this.retries) throw err;
        const wait = err.retryAfter ? err.retryAfter * 1000 : 400 * 2 ** attempt;
        this.opts.log?.(`[im/telegram] ${err.message}; retry ${attempt + 1}/${this.retries} in ${wait}ms`);
        await this.sleepFn(wait);
        attempt++;
      }
    }
  }

  /** Download a file by its file_path (from getFile). */
  async download(filePath: string): Promise<Buffer> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.f(`${this.base}/file/bot${this.opts.token}/${filePath}`);
        if (!res.ok) throw new TelegramError(`download: HTTP ${res.status}`, res.status, undefined, res.status >= 500);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        const err = e instanceof TelegramError ? e : new TelegramError(`download: network error: ${this.scrub(String((e as Error)?.message ?? e))}`, undefined, undefined, true);
        if (!(err.network || (err.code ?? 0) >= 500) || attempt >= this.retries) throw err;
        await this.sleepFn(400 * 2 ** attempt);
        attempt++;
      }
    }
  }
}
