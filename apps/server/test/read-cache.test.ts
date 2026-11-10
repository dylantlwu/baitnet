import { describe, expect, it, vi } from "vitest";
import { CachedRegistryClient, MemoryRegistryClient } from "@baitnet/guard";
import type { Env } from "@baitnet/agent";
import { withReadCache } from "../src/data.js";

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
});
