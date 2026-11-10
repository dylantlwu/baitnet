import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { AttestationResult } from "@baitnet/shared";
import { AttestationCache, ATTESTATION_RETRY_MS, DEFAULT_ATTESTATION_CACHE_MS } from "../src/attestation.js";
import { createApp } from "../src/app.js";

const live = (n: string): AttestationResult => ({ model: "m", nonce: n, checks: [], verified: true, recorded: false, at: `t-${n}` });
const recorded: AttestationResult = { model: "m", nonce: "rec", checks: [], verified: true, recorded: true, at: "2026-01-01" };

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe("AttestationCache (GET /attestation)", () => {
  it("live: first call fetches, later calls are served from the cache until the TTL", async () => {
    const c = clock();
    const load = vi.fn().mockResolvedValueOnce(live("1")).mockResolvedValueOnce(live("2"));
    const cache = new AttestationCache(load, { now: c.now });
    const first = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(first.map((r) => r.nonce)).toEqual(["1", "1", "1"]);
    expect(load).toHaveBeenCalledTimes(1);
    c.tick(DEFAULT_ATTESTATION_CACHE_MS - 1);
    expect((await cache.get()).nonce).toBe("1");
    expect(load).toHaveBeenCalledTimes(1);
    c.tick(2);
    // stale: answered immediately with the cached report, refreshed in the background
    expect((await cache.get()).nonce).toBe("1");
    expect(load).toHaveBeenCalledTimes(2);
    await cache.refresh(); // joins the in-flight refresh
    expect(load).toHaveBeenCalledTimes(2);
    expect((await cache.get()).nonce).toBe("2");
  });

  it("a failed live refresh (recorded fallback or error) keeps the last live result and retries sooner", async () => {
    const c = clock();
    const load = vi.fn<() => Promise<AttestationResult>>().mockResolvedValueOnce(live("1")).mockResolvedValueOnce(recorded).mockRejectedValueOnce(new Error("down")).mockResolvedValue(live("3"));
    const cache = new AttestationCache(load, { now: c.now, ttlMs: 600_000 });
    await cache.get();
    c.tick(600_000);
    expect(await cache.refresh()).toMatchObject({ nonce: "1", recorded: false });
    c.tick(ATTESTATION_RETRY_MS - 1);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2); // not yet
    c.tick(1);
    await cache.get();
    await cache.refresh().catch(() => {});
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.peek()?.nonce).toBe("1");
    c.tick(ATTESTATION_RETRY_MS);
    await cache.get();
    expect((await cache.refresh()).nonce).toBe("3");
  });

  it("offline / recorded results are cached for the retry interval; a first-call error is not cached", async () => {
    const c = clock();
    const load = vi.fn<() => Promise<AttestationResult>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(recorded);
    const cache = new AttestationCache(load, { now: c.now });
    await expect(cache.get()).rejects.toThrow("boom");
    expect(await cache.get()).toEqual(recorded);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    c.tick(ATTESTATION_RETRY_MS);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("the server calls the attestation source once for many GET /attestation, and warm() pre-loads it", async () => {
    process.env.BAITNET_REGISTRY = "memory";
    let n = 0;
    const att = vi.fn(async () => live(String(++n)));
    const app = createApp({ log: () => {}, attestation: att, mountTraining: false, startIm: false });
    await app.ready;
    await new Promise<void>((r) => app.listen(0, r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      await app.warm();
      expect(att).toHaveBeenCalledTimes(1);
      const rs = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/attestation`).then((r) => r.json())));
      expect(rs.every((r) => r.nonce === "1")).toBe(true);
      expect(att).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });
});
