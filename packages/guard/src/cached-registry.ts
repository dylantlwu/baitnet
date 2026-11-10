import type { AckOutcome, AlertStatus, Chain } from "@baitnet/shared";
import type { RegistryClient, ReportArgs } from "./registry.js";

/**
 * Short-TTL read cache with in-flight de-duplication: concurrent callers for the
 * same key share one promise, and a result is reused for `ttlMs`. Failures are
 * not cached. `invalidate()` drops everything, including in-flight entries (a
 * read that started before a write must not repopulate the cache afterwards).
 */
export class TtlCache {
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

/** Default TTL for registry reads served to the dashboard (BAITNET_REGISTRY_CACHE_MS overrides; 0 disables). */
export const DEFAULT_REGISTRY_CACHE_MS = 4000;

/**
 * RegistryClient decorator for servers: view calls go through a shared TtlCache
 * (so N dashboards polling /alerts cost one RPC per TTL), change calls go
 * straight through and invalidate the cache. Clients derived with `as()` share
 * the cache, so a write by any signer invalidates reads for everyone.
 */
export class CachedRegistryClient implements RegistryClient {
  constructor(
    readonly inner: RegistryClient,
    readonly cache: TtlCache = new TtlCache(DEFAULT_REGISTRY_CACHE_MS),
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
