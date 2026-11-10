import { describe, expect, it, vi } from "vitest";
import { CachedRegistryClient, MemoryRegistryClient, SwrCache } from "@baitnet/guard";
import type { Env } from "@baitnet/agent";
import { DataSource, withReadCache } from "../src/data.js";

const H = "c".repeat(64);

function chainEnv(): { env: Env; inner: MemoryRegistryClient } {
  // a memory client standing in for ChainRegistryClient: only the mode decides whether we cache
  const inner = new MemoryRegistryClient({ caller: "reporter.test.near" });
  return { inner, env: { mode: "chain", network: "testnet", registry: inner, registryAs: (a) => inner.as(a.accountId) } };
}

describe("server registry read cache", () => {
  it("wraps chain registries (shared cache for registryAs) and leaves memory mode alone", () => {
    const { env } = chainEnv();
    const cached = withReadCache(env, 4000);
    expect(cached.registry).toBeInstanceOf(CachedRegistryClient);
    expect((cached.registry as CachedRegistryClient).cache).toBeInstanceOf(SwrCache);
    const as = cached.registryAs({ accountId: "wallet.test.near", privateKey: "ed25519:x" });
    expect((as as CachedRegistryClient).cache).toBe((cached.registry as CachedRegistryClient).cache);
    expect(withReadCache(env, 0).registry).toBe(env.registry);
    const mem: Env = { ...env, mode: "memory", network: "memory" };
    expect(withReadCache(mem, 4000)).toBe(mem);
  });

  it("many concurrent /alerts-style reads cost one registry call; a write through the server invalidates", async () => {
    const { env, inner } = chainEnv();
    const spy = vi.spyOn(inner, "listAlerts");
    const reg = withReadCache(env, 4000).registry;
    await Promise.all(Array.from({ length: 20 }, () => reg.listAlerts(0, 100)));
    expect(spy).toHaveBeenCalledTimes(1);
    await reg.report({ chain: "near", address: "scam.test.near", evidenceHash: H, level: "L1", category: "x" });
    expect(await reg.listAlerts(0, 100)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stale-while-revalidate: polls never wait after the first load, background reload picks up other writers", async () => {
    const { env, inner } = chainEnv();
    const spy = vi.spyOn(inner, "listAlerts");
    const reg = withReadCache(env, 50).registry as CachedRegistryClient;
    const cache = reg.cache as SwrCache;
    try {
      expect(await reg.listAlerts(0, 100)).toEqual([]);
      // another process (agent CLI) writes straight to the chain, not through this server
      await inner.report({ chain: "near", address: "scam.test.near", evidenceHash: H, level: "L1", category: "x" });
      await new Promise((r) => setTimeout(r, 60));
      expect(await reg.listAlerts(0, 100)).toEqual([]); // stale value, answered at once …
      await cache.settle(); // … while it reloads in the background
      expect(await reg.listAlerts(0, 100)).toHaveLength(1);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      cache.stop();
    }
  });

  it("DataSource: acks are read a few at a time, served from the cache afterwards", async () => {
    const { env, inner } = chainEnv();
    for (let i = 0; i < 9; i++) await inner.report({ chain: "near", address: `scam${i}.test.near`, evidenceHash: H, level: "L1", category: "x" });
    let running = 0;
    let peak = 0;
    const orig = inner.getAcks.bind(inner);
    const spy = vi.spyOn(inner, "getAcks").mockImplementation(async (id) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return orig(id);
    });
    const cachedEnv = withReadCache(env, 60_000);
    const ds = new DataSource();
    (ds as unknown as { env: Env; envKey: string }).env = cachedEnv;
    (ds as unknown as { envKey: string }).envKey = `${process.env.BAITNET_REGISTRY ?? ""}|false`;
    try {
      const alerts = await ds.alerts();
      expect(alerts).toHaveLength(9);
      await ds.acks(alerts);
      expect(peak).toBeGreaterThan(1); // not one after another
      expect(peak).toBeLessThanOrEqual(4);
      expect(spy).toHaveBeenCalledTimes(9);
      await ds.acks(alerts);
      expect(spy).toHaveBeenCalledTimes(9); // second time: all from the cache
    } finally {
      ds.stop();
    }
  });
});
