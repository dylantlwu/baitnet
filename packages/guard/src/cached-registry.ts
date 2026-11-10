import type { AckOutcome, AlertStatus, Chain } from "@baitnet/shared";
import type { RegistryClient, ReportArgs } from "./registry.js";

/**
 * Short-TTL read cache with in-flight de-duplication: concurrent callers for the
 * same key share one promise, and a result is reused for `ttlMs`. Failures are
 * not cached. `invalidate()` drops everything, including in-flight entries (a
 * read that started before a write must not repopulate the cache afterwards).
 */
export class TtlCache implements RegistryReadCache {
  private entries = new Map<string, { at: number; value: unknown }>();
  private inflight = new Map<string, { gen: number; p: Promise<unknown> }>();
  private gen = 0;
  hits = 0;
  misses = 0;

  constructor(
    readonly ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const e = this.entries.get(key);
    if (e && this.now() - e.at < this.ttlMs) {
      this.hits++;
      return Promise.resolve(e.value as T);
    }
    const f = this.inflight.get(key);
    if (f && f.gen === this.gen) {
      this.hits++;
      return f.p as Promise<T>;
    }
    this.misses++;
    const gen = this.gen;
    const p = load().then(
      (value) => {
        if (gen === this.gen) this.entries.set(key, { at: this.now(), value });
        if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
        return value;
      },
      (err) => {
        if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, { gen, p });
    return p;
  }

  invalidate() {
    this.gen++;
    this.entries.clear();
    this.inflight.clear();
  }
}

/** What CachedRegistryClient needs from a cache: `ttlMs > 0` enables it. */
export interface RegistryReadCache {
  readonly ttlMs: number;
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
  invalidate(): void;
}

export interface SwrCacheOptions {
  /** A value older than this is served once more and refreshed in the background (and by the timer). */
  refreshMs: number;
  /** Keys nobody read for this long are no longer refreshed by the timer (default 10 min). */
  idleMs?: number;
  /**
   * A value older than this (e.g. after an idle period) is not served blindly: the read waits for a
   * reload and only falls back to the old value if that reload fails (default = idleMs).
   */
  maxStaleMs?: number;
  /** Parallel background reloads (default 4): public RPCs answer bursts with 429. */
  concurrency?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface SwrEntry {
  value: unknown;
  at: number;
  /** cache generation the value was loaded in; older generations predate a write */
  gen: number;
  lastRead: number;
  load: () => Promise<unknown>;
}

/**
 * Stale-while-revalidate cache for server reads (dashboards poll every 10 s, a public NEAR RPC
 * answers in 0.5–4 s):
 *   - a read with a cached value returns it immediately; if it is older than `refreshMs` a
 *     background reload is started (de-duplicated per key);
 *   - `start()` runs a timer that reloads every key read within `idleMs` before it goes stale,
 *     so polling clients practically never wait;
 *   - `invalidate()` (after a write) moves to a new generation: values from before the write are
 *     never served again — reads wait for a reload, which is kicked off right away for hot keys —
 *     and a reload that started before the write cannot repopulate the cache;
 *   - failed background reloads keep the previous value (logged); failures are never cached.
 */
export class SwrCache implements RegistryReadCache {
  private entries = new Map<string, SwrEntry>();
  private inflight = new Map<string, { gen: number; p: Promise<unknown> }>();
  private gen = 0;
  private timer?: ReturnType<typeof setInterval>;
  private queue: (() => void)[] = [];
  private running = 0;
  private readonly now: () => number;
  readonly idleMs: number;
  readonly maxStaleMs: number;
  /** served fresh / served stale (+ background reload) / waited for a load / background reloads run */
  stats = { hits: 0, stale: 0, misses: 0, reloads: 0, failures: 0 };
  lastError?: string;

  constructor(readonly opts: SwrCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 600_000;
    this.maxStaleMs = opts.maxStaleMs ?? this.idleMs;
  }

  get ttlMs() {
    return this.opts.refreshMs;
  }

  /** Timer period: a hot key is reloaded once its value is older than refreshMs - tickMs. */
  get tickMs() {
    return Math.max(250, Math.round(this.opts.refreshMs / 4));
  }

  get size() {
    return this.entries.size;
  }

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const e = this.entries.get(key);
    if (e) {
      e.lastRead = now;
      e.load = load;
    }
    if (e && e.gen === this.gen) {
      const age = now - e.at;
      if (age < this.opts.refreshMs) {
        this.stats.hits++;
        return Promise.resolve(e.value as T);
      }
      if (age < this.maxStaleMs) {
        this.stats.stale++;
        this.background(key);
        return Promise.resolve(e.value as T);
      }
      // too old to serve blindly (idle period): wait, but an unreachable RPC still gets the old value
      this.stats.misses++;
      return this.load(key, load).catch((err) => {
        this.opts.log?.(`[cache] ${key}: reload failed, serving a ${Math.round(age / 1000)} s old value (${(err as Error).message})`);
        return e.value as T;
      });
    }
    // never loaded, or loaded before a write (invalidated): wait for a fresh value
    this.stats.misses++;
    return this.load(key, load);
  }

  /** Drop every value loaded so far (a write happened) and reload the keys that are being read. */
  invalidate() {
    this.gen++;
    this.inflight.clear();
    const now = this.now();
    for (const [key, e] of this.entries) if (now - e.lastRead < this.idleMs) this.background(key);
  }

  /** Reload hot keys before they go stale; drop keys nobody asked for in a long time. Timer is unref'd. */
  start() {
    if (this.timer || !(this.opts.refreshMs > 0)) return this;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One timer step (exposed for tests). */
  tick() {
    const now = this.now();
    for (const [key, e] of this.entries) {
      const idle = now - e.lastRead;
      if (idle > this.idleMs * 6) this.entries.delete(key);
      else if (idle < this.idleMs && (e.gen !== this.gen || now - e.at >= this.opts.refreshMs - this.tickMs)) this.background(key);
    }
  }

  /** Wait until no background reload is queued or running (tests, warm-up). */
  async settle() {
    while (this.inflight.size || this.queue.length || this.running) {
      await Promise.allSettled([...this.inflight.values()].map((f) => f.p));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private background(key: string) {
    const f = this.inflight.get(key);
    if (f && f.gen === this.gen) return;
    const e = this.entries.get(key);
    if (!e) return;
    const gen = this.gen;
    // the slot is taken by a queued promise so the same key is not queued twice
    let p!: Promise<void>;
    const done = (resolve: () => void) => {
      // free the slot before anyone awaiting `p` continues
      if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
      resolve();
    };
    p = new Promise<void>((resolve) => {
      this.queue.push(() => {
        if (gen !== this.gen) {
          done(resolve);
          return;
        }
        this.running++;
        this.stats.reloads++;
        this.run(key, e.load, gen)
          .catch((err) => {
            this.stats.failures++;
            this.opts.log?.(`[cache] background reload of ${key} failed: ${(err as Error).message}`);
          })
          .finally(() => {
            this.running--;
            done(resolve);
            this.pump();
          });
      });
    });
    this.inflight.set(key, { gen, p });
    this.pump();
  }

  private pump() {
    while (this.running < (this.opts.concurrency ?? 4) && this.queue.length) this.queue.shift()!();
  }

  /** Foreground load: joins a same-generation reload of this key if one is queued/running. */
  private load<T>(key: string, load: () => Promise<T>): Promise<T> {
    const f = this.inflight.get(key);
    if (f && f.gen === this.gen) {
      // a queued background reload resolves to void: wait for it, then read what it stored
      return f.p.then(() => {
        const e = this.entries.get(key);
        return e && e.gen === this.gen ? (e.value as T) : this.load(key, load);
      });
    }
    const gen = this.gen;
    let tracked!: Promise<unknown>;
    // the slot is freed before the caller (or anyone joining) continues
    const p = this.run(key, load, gen).finally(() => {
      if (this.inflight.get(key)?.p === tracked) this.inflight.delete(key);
    });
    tracked = p.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(key, { gen, p: tracked });
    return p;
  }

  private async run<T>(key: string, load: () => Promise<T>, gen: number): Promise<T> {
    try {
      const value = await load();
      if (gen === this.gen) {
        const prev = this.entries.get(key);
        this.entries.set(key, { value, at: this.now(), gen, lastRead: prev?.lastRead ?? this.now(), load });
        this.lastError = undefined;
      }
      return value;
    } catch (err) {
      this.lastError = `${key}: ${(err as Error).message}`;
      throw err;
    }
  }
}

/**
 * Default background refresh interval for registry reads served to the dashboard
 * (BAITNET_REGISTRY_CACHE_MS overrides; 0 disables caching). The dashboard polls every 10 s.
 */
export const DEFAULT_REGISTRY_CACHE_MS = 15_000;

/**
 * RegistryClient decorator for servers: view calls go through a shared cache
 * (SwrCache on the server: N dashboards polling /alerts cost one background RPC per
 * refresh interval), change calls go straight through and invalidate the cache. Clients
 * derived with `share()` share the cache, so a write by any signer invalidates reads for everyone.
 */
export class CachedRegistryClient implements RegistryClient {
  constructor(
    readonly inner: RegistryClient,
    readonly cache: RegistryReadCache = new TtlCache(4000),
  ) {}

  get kind() {
    return this.inner.kind;
  }
  get contractId() {
    return this.inner.contractId;
  }

  /** Wrap another client (e.g. the same registry bound to a different signer) onto this cache. */
  share(other: RegistryClient): CachedRegistryClient {
    return new CachedRegistryClient(other, this.cache);
  }

  invalidate() {
    this.cache.invalidate();
  }

  private read<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.cache.ttlMs > 0 ? this.cache.get(key, load) : load();
  }

  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      // even a failed tx may have landed (timeout after broadcast): never serve pre-write data
      this.cache.invalidate();
    }
  }

  report(a: ReportArgs) {
    return this.write(() => this.inner.report(a));
  }
  setStatus(alertId: number, status: AlertStatus, reasonHash?: string) {
    return this.write(() => this.inner.setStatus(alertId, status, reasonHash));
  }
  registerResponder(name: string) {
    return this.write(() => this.inner.registerResponder(name));
  }
  ack(alertId: number, outcome: AckOutcome) {
    return this.write(() => this.inner.ack(alertId, outcome));
  }

  check(chain: Chain, address: string) {
    return this.read(`check|${chain}|${address}`, () => this.inner.check(chain, address));
  }
  listAlerts(fromIndex = 0, limit = 50) {
    return this.read(`listAlerts|${fromIndex}|${limit}`, () => this.inner.listAlerts(fromIndex, limit));
  }
  getAlert(id: number) {
    return this.read(`getAlert|${id}`, () => this.inner.getAlert(id));
  }
  getAcks(alertId: number) {
    return this.read(`getAcks|${alertId}`, () => this.inner.getAcks(alertId));
  }
  getResponder(accountId: string) {
    return this.read(`getResponder|${accountId}`, () => this.inner.getResponder(accountId));
  }
  listResponders(fromIndex = 0, limit = 50) {
    return this.read(`listResponders|${fromIndex}|${limit}`, () => this.inner.listResponders(fromIndex, limit));
  }
}
