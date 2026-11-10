import { describe, expect, it, vi } from "vitest";
import { CachedRegistryClient, MemoryRegistryClient, SwrCache, type RegistryClient } from "../src/index.js";

const H = "b".repeat(64);

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

/** A loader whose calls are counted and can be held open / made to fail. */
function loader<T>(values: T[]) {
  let i = 0;
  let fail: Error | undefined;
  let gate: Promise<void> | undefined;
  const fn = vi.fn(async () => {
    if (gate) await gate;
    if (fail) throw fail;
    return values[Math.min(i++, values.length - 1)]!;
  });
  return {
    fn,
    failWith: (e?: Error) => (fail = e),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

async function setupRegistry(refreshMs = 15_000) {
  const c = clock();
  const inner = new MemoryRegistryClient({ caller: "reporter.test.near" });
  await inner.report({ chain: "near", address: "goldbridge-desk.near", evidenceHash: H, level: "L1", category: "investment" });
  const spy = vi.spyOn(inner, "listAlerts");
  const cache = new SwrCache({ refreshMs, now: c.now });
  const reg = new CachedRegistryClient(inner, cache);
  return { c, inner, spy, cache, reg };
}

describe("SwrCache (stale-while-revalidate)", () => {
  it("first read waits; later reads are served from memory, concurrent first reads share one load", async () => {
    const c = clock();
    const cache = new SwrCache({ refreshMs: 15_000, now: c.now });
    const l = loader(["v1"]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => cache.get("k", l.fn)));
    expect(rs).toEqual(Array(10).fill("v1"));
    expect(l.fn).toHaveBeenCalledTimes(1);
    c.tick(5_000);
    expect(await cache.get("k", l.fn)).toBe("v1");
    expect(l.fn).toHaveBeenCalledTimes(1);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 10 });
  });

  it("a stale value is returned at once and reloaded in the background", async () => {
    const c = clock();
    const cache = new SwrCache({ refreshMs: 15_000, now: c.now });
    const l = loader(["v1", "v2"]);
    await cache.get("k", l.fn);
    c.tick(16_000);
    const release = l.hold();
    // the reload is held open, the read still answers immediately with the old value
    expect(await cache.get("k", l.fn)).toBe("v1");
    expect(await cache.get("k", l.fn)).toBe("v1");
    expect(l.fn).toHaveBeenCalledTimes(2); // one background reload, not one per read
    release();
    await cache.settle();
    expect(await cache.get("k", l.fn)).toBe("v2");
    expect(cache.stats.stale).toBe(2);
  });

  it("a failed background reload keeps serving the previous value and is not cached", async () => {
    const c = clock();
    const log = vi.fn();
    const cache = new SwrCache({ refreshMs: 15_000, now: c.now, log });
    const l = loader(["v1", "v2"]);
    await cache.get("k", l.fn);
    c.tick(16_000);
    l.failWith(new Error("RPC HTTP 429"));
    expect(await cache.get("k", l.fn)).toBe("v1");
    await cache.settle();
    expect(cache.lastError).toMatch(/429/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/background reload of k failed/));
    l.failWith(undefined);
    expect(await cache.get("k", l.fn)).toBe("v1"); // still stale → another background reload
    await cache.settle();
    expect(await cache.get("k", l.fn)).toBe("v2");
    expect(cache.lastError).toBeUndefined();
  });

  it("after a long idle period the read waits for a reload, and falls back to the old value if it fails", async () => {
    const c = clock();
    const cache = new SwrCache({ refreshMs: 15_000, maxStaleMs: 60_000, now: c.now });
    const l = loader(["v1", "v2"]);
    await cache.get("k", l.fn);
    c.tick(61_000);
    expect(await cache.get("k", l.fn)).toBe("v2");
    c.tick(61_000);
    l.failWith(new Error("down"));
    expect(await cache.get("k", l.fn)).toBe("v2");
  });

  it("the timer reloads keys that are being read before they go stale, and leaves idle keys alone", async () => {
    const c = clock();
    const cache = new SwrCache({ refreshMs: 16_000, idleMs: 60_000, now: c.now });
    const hot = loader(["h1", "h2", "h3"]);
    const cold = loader(["c1", "c2"]);
    await cache.get("hot", hot.fn);
    await cache.get("cold", cold.fn);
    c.tick(cache.tickMs * 3); // 12 s: refreshMs - tickMs reached
    await cache.get("hot", hot.fn); // still fresh: a hit, and marks the key as read
    cache.tick();
    await cache.settle();
    expect(hot.fn).toHaveBeenCalledTimes(2);
    expect(cold.fn).toHaveBeenCalledTimes(2); // read 12 s ago: still hot
    c.tick(70_000); // nobody read "cold" (or "hot") for 70 s
    cache.tick();
    await cache.settle();
    expect(hot.fn).toHaveBeenCalledTimes(2);
    expect(cold.fn).toHaveBeenCalledTimes(2);
    c.tick(60_000 * 6);
    cache.tick();
    expect(cache.size).toBe(0); // forgotten after 6 × idleMs
  });

  it("start() runs the timer, stop() ends it", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SwrCache({ refreshMs: 4_000 }).start();
      const l = loader(["a", "b"]);
      await cache.get("k", l.fn);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(l.fn).toHaveBeenCalledTimes(2);
      cache.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(l.fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("background reloads run at most `concurrency` at a time", async () => {
    const c = clock();
    const cache = new SwrCache({ refreshMs: 15_000, concurrency: 2, now: c.now });
    let running = 0;
    let peak = 0;
    const slow = (v: string) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return v;
    };
    for (let i = 0; i < 6; i++) await cache.get(`k${i}`, slow(`v${i}`));
    c.tick(16_000);
    peak = 0;
    for (let i = 0; i < 6; i++) await cache.get(`k${i}`, slow(`w${i}`));
    await cache.settle();
    expect(peak).toBe(2);
    expect(await cache.get("k5", slow("x"))).toBe("w5");
  });
});

describe("CachedRegistryClient on SwrCache: writes", () => {
  it("a write through the server is visible to the next read (no pre-write value is served)", async () => {
    const { reg, spy, c } = await setupRegistry();
    expect(await reg.listAlerts(0, 100)).toHaveLength(1);
    c.tick(1_000);
    await reg.report({ chain: "evm", address: "0x7D72774a3c9680e6d2921350f889b48ba2f3b24d", evidenceHash: H, level: "L2", category: "trace" });
    // the hot key is reloaded right after the write, without waiting for a reader
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await reg.listAlerts(0, 100)).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("writes by a shared (other signer) client and failed writes invalidate too", async () => {
    const { reg, inner } = await setupRegistry();
    expect((await reg.listAlerts(0, 100))[0]!.status).toBe("Active");
    const other = reg.share(inner.as("reporter.test.near"));
    await other.setStatus(0, "Disputed");
    expect((await reg.listAlerts(0, 100))[0]!.status).toBe("Disputed");
    // a write that throws (e.g. timeout after broadcast) may still have landed
    await expect(other.setStatus(0, "Disputed")).rejects.toThrow(/SAME_STATUS/);
    expect((reg.cache as SwrCache).stats.reloads).toBeGreaterThanOrEqual(2);
  });

  it("acks: register_responder + ack through the server show up on the next read", async () => {
    const { reg, inner } = await setupRegistry();
    expect(await reg.getAcks(0)).toEqual([]);
    expect(await reg.listResponders()).toEqual([]);
    const responder = reg.share(inner.as("bank.test.near"));
    await responder.registerResponder("Bank");
    await responder.ack(0, "Blocked");
    expect(await reg.getAcks(0)).toMatchObject([{ alertId: 0, responder: "bank.test.near", outcome: "Blocked" }]);
    expect(await reg.listResponders()).toMatchObject([{ accountId: "bank.test.near", name: "Bank" }]);
  });

  it("a reload that started before a write does not put pre-write data back", async () => {
    const { reg, spy, c, inner } = await setupRegistry();
    await reg.listAlerts(0, 100);
    c.tick(16_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = spy.getMockImplementation();
    spy.mockImplementationOnce(async (...a) => {
      const before = await (orig ? orig(...a) : inner.listAlerts(...a));
      await gate; // read finished on the node before the write, response arrives after it
      return before as never;
    });
    expect(await reg.listAlerts(0, 100)).toHaveLength(1); // stale → background reload (held)
    await reg.report({ chain: "near", address: "second.near", evidenceHash: H, level: "L2", category: "x" });
    release();
    await (reg.cache as SwrCache).settle();
    expect(await reg.listAlerts(0, 100)).toHaveLength(2);
  });

  it("a read after a write waits for the post-write reload instead of serving the old value", async () => {
    const { reg, spy } = await setupRegistry();
    await reg.listAlerts(0, 100);
    const orig = spy.getMockImplementation();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    spy.mockImplementationOnce(async (...a) => {
      await gate;
      return (await (orig as (...x: unknown[]) => Promise<unknown>)(...a)) as never;
    });
    await reg.report({ chain: "near", address: "third.near", evidenceHash: H, level: "L2", category: "x" });
    let done = false;
    const read = reg.listAlerts(0, 100).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    release();
    expect(await read).toHaveLength(2);
  });

  it("failures are not cached for first reads either", async () => {
    let n = 0;
    const flaky = {
      kind: "chain",
      contractId: "r.test",
      listAlerts: async () => {
        if (n++ === 0) throw new Error("RPC query HTTP 429");
        return [];
      },
    } as unknown as RegistryClient;
    const reg = new CachedRegistryClient(flaky, new SwrCache({ refreshMs: 15_000 }));
    await expect(reg.listAlerts()).rejects.toThrow(/429/);
    await expect(reg.listAlerts()).resolves.toEqual([]);
  });
});
