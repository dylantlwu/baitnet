import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CachedRegistryClient,
  MemoryRegistryClient,
  ResilientRpcProvider,
  TESTNET_FALLBACK_RPC,
  TtlCache,
  parseRetryAfter,
  parseRpcUrls,
  resetRpcHealth,
  rpcCall,
  rpcLatencies,
  withRpcRetry,
  viewFunction,
  type RegistryClient,
} from "../src/index.js";

const H = "a".repeat(64);

/** Virtual clock: sleep() advances time instantly and records the waits. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
    random: () => 0.5,
  };
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
/** fetch mock: per-URL queue of replies (last one repeats). Records the URLs hit. */
function mockFetch(script: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const q = script[u];
    if (!q?.length) throw new Error(`unexpected fetch ${u}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: "1", result } });
const viewOk = (value: unknown) => ok({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: "x" });

beforeEach(() => resetRpcHealth());
afterEach(() => vi.unstubAllGlobals());

describe("rpc retry / failover", () => {
  it("retries HTTP 429 with backoff and then succeeds", async () => {
    const k = clock();
    const { calls } = mockFetch({ "http://a.test": [{ status: 429 }, { status: 429 }, ok({ chain_id: "testnet" })] });
    const r = await rpcCall<{ chain_id: string }>("http://a.test", "status", [], k);
    expect(r.chain_id).toBe("testnet");
    expect(calls).toHaveLength(3);
    // equal jitter with random=0.5: 0.75 × 250, then 0.75 × 500
    expect(k.waits).toEqual([187.5, 375]);
  });

  it("honours Retry-After (seconds and HTTP date)", async () => {
    const k = clock();
    mockFetch({ "http://a.test": [{ status: 429, headers: { "retry-after": "2" } }, ok("done")] });
    await expect(rpcCall("http://a.test", "status", [], k)).resolves.toBe("done");
    expect(k.waits[0]).toBeGreaterThanOrEqual(2000);
    expect(k.waits[0]).toBeLessThan(2000 + 250);

    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000 + 5000).toUTCString(), 10_000)).toBeGreaterThanOrEqual(4000);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("gives up when Retry-After exceeds the total budget (single endpoint)", async () => {
    const k = clock();
    mockFetch({ "http://a.test": [{ status: 429, headers: { "retry-after": "120" } }] });
    await expect(rpcCall("http://a.test", "status", [], { ...k, totalTimeoutMs: 10_000 })).rejects.toThrow(/HTTP 429.*gave up/);
  });

  it("fails over to the next endpoint immediately and keeps the bad one cooling down", async () => {
    const k = clock();
    const { calls } = mockFetch({ "http://a.test": [{ status: 503 }], "http://b.test": [ok("from-b")] });
    await expect(rpcCall("http://a.test, http://b.test", "status", [], k)).resolves.toBe("from-b");
    expect(calls).toEqual(["http://a.test", "http://b.test"]);
    expect(k.waits).toEqual([]); // no sleep: b was healthy
    // next call skips a (still in cooldown) and goes straight to b
    await expect(rpcCall("http://a.test,http://b.test", "status", [], k)).resolves.toBe("from-b");
    expect(calls.slice(2)).toEqual(["http://b.test"]);
  });

  it("prefers the fastest healthy endpoint once both have been measured", async () => {
    const k = clock();
    const speed: Record<string, number> = { "http://slow.test": 3500, "http://fast.test": 500 };
    const hits: string[] = [];
    const call = (url: string) => {
      hits.push(url);
      return k.sleep(speed[url]!).then(() => url);
    };
    const urls = ["http://slow.test", "http://fast.test"];
    // unmeasured endpoints count as 0: the first call goes in configured order, then the unmeasured one
    await withRpcRetry(urls, call, k);
    await withRpcRetry(urls, call, k);
    for (let i = 0; i < 3; i++) await withRpcRetry(urls, call, k);
    expect(hits).toEqual(["http://slow.test", "http://fast.test", "http://fast.test", "http://fast.test", "http://fast.test"]);
    expect(rpcLatencies()).toEqual({ "http://slow.test": 3500, "http://fast.test": 500 });
    // the fast one failing still fails over to the slow one
    const failing = (url: string) => (url === "http://fast.test" ? Promise.reject(Object.assign(new Error("fetch failed"))) : call(url));
    await expect(withRpcRetry(urls, failing, k)).resolves.toBe("http://slow.test");
    // calls that legitimately block (send_tx) do not count
    await withRpcRetry(["http://slow.test"], (u) => k.sleep(60_000).then(() => u), { ...k, trackLatency: false });
    expect(rpcLatencies()["http://slow.test"]).toBe(3500);
  });

  it("retries network errors and timeouts", async () => {
    const k = clock();
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    mockFetch({ "http://a.test": [new TypeError("fetch failed"), timeout, ok(1)] });
    await expect(rpcCall("http://a.test", "status", [], k)).resolves.toBe(1);
  });

  it("does not retry contract / request errors", async () => {
    const k = clock();
    const { calls } = mockFetch({
      "http://a.test": [{ status: 200, body: { jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } } }],
    });
    await expect(rpcCall("http://a.test", "query", {}, k)).rejects.toThrow(/UNKNOWN_ACCOUNT/);
    expect(calls).toHaveLength(1);
    const c2 = mockFetch({ "http://a.test": [{ status: 400 }] });
    await expect(rpcCall("http://a.test", "query", {}, k)).rejects.toThrow(/HTTP 400/);
    expect(c2.calls).toHaveLength(1);
  });

  it("stops after maxAttempts", async () => {
    const k = clock();
    const { calls } = mockFetch({ "http://a.test": [{ status: 502 }] });
    await expect(rpcCall("http://a.test", "status", [], { ...k, maxAttempts: 3 })).rejects.toThrow(/HTTP 502/);
    expect(calls).toHaveLength(3);
  });

  it("viewFunction decodes and passes finality", async () => {
    const k = clock();
    const { fn } = mockFetch({ "http://a.test": [{ status: 429 }, viewOk({ id: 7 })] });
    await expect(viewFunction("http://a.test", "registry.test", "check", { chain: "near", address: "x.near" }, { ...k, finality: "final" })).resolves.toEqual({ id: 7 });
    const body = JSON.parse(String(fn.mock.calls[1]![1]!.body));
    expect(body.params.finality).toBe("final");
  });

  it("parses comma-separated endpoints and adds the built-in testnet fallback", () => {
    expect(parseRpcUrls("https://rpc.testnet.near.org", {})).toEqual(["https://rpc.testnet.near.org", TESTNET_FALLBACK_RPC]);
    expect(parseRpcUrls("https://rpc.testnet.near.org", { NEAR_RPC_NO_FALLBACK: "1" })).toEqual(["https://rpc.testnet.near.org"]);
    expect(parseRpcUrls(" https://a/ , https://b ,https://a", {})).toEqual(["https://a", "https://b"]);
    expect(parseRpcUrls("http://127.0.0.1:3030", {})).toEqual(["http://127.0.0.1:3030"]);
  });
});

describe("ResilientRpcProvider (near-api-js, used for transactions)", () => {
  it("retries 429 (which near-api-js alone never retries) and fails over", async () => {
    const { calls } = mockFetch({ "http://a.test": [{ status: 429 }], "http://b.test": [viewOk({ ok: true })] });
    const p = new ResilientRpcProvider("http://a.test,http://b.test", { sleep: async () => {} });
    await expect(p.callFunction({ contractId: "registry.test", method: "stats", args: {} })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["http://a.test", "http://b.test"]);
  });

  it("does not retry RPC handler errors", async () => {
    const { calls } = mockFetch({
      "http://a.test": [{ status: 200, body: { jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "nope.test" } } } } }],
    });
    const p = new ResilientRpcProvider("http://a.test", { sleep: async () => {} });
    await expect(p.viewAccount({ accountId: "nope.test" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("TtlCache / CachedRegistryClient", () => {
  async function setup(ttl = 4000) {
    let t = 0;
    const inner = new MemoryRegistryClient({ caller: "reporter.test.near" });
    await inner.report({ chain: "near", address: "goldbridge-desk.near", evidenceHash: H, level: "L1", category: "investment" });
    const spy = vi.spyOn(inner, "listAlerts");
    const cache = new TtlCache(ttl, () => t);
    const reg = new CachedRegistryClient(inner, cache);
    return { inner, reg, spy, cache, tick: (ms: number) => (t += ms) };
  }

  it("serves repeated reads from cache within the TTL and reloads after it", async () => {
    const { reg, spy, tick } = await setup();
    await reg.listAlerts(0, 100);
    await reg.listAlerts(0, 100);
    expect(spy).toHaveBeenCalledTimes(1);
    tick(4001);
    await reg.listAlerts(0, 100);
    expect(spy).toHaveBeenCalledTimes(2);
    await reg.listAlerts(1, 100); // different args → different key
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("merges concurrent identical reads into one call", async () => {
    const { reg, spy } = await setup();
    const rs = await Promise.all(Array.from({ length: 10 }, () => reg.listAlerts(0, 100)));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rs.every((r) => r.length === 1)).toBe(true);
  });

  it("invalidates on report / setStatus, also for clients shared via share()", async () => {
    const { inner, reg, spy } = await setup();
    expect(await reg.listAlerts(0, 100)).toHaveLength(1);
    await reg.report({ chain: "evm", address: "0x7D72774a3c9680e6d2921350f889b48ba2f3b24d", evidenceHash: H, level: "L2", category: "trace" });
    expect(await reg.listAlerts(0, 100)).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
    const other = reg.share(inner.as("reporter.test.near"));
    await other.setStatus(0, "Revoked");
    expect((await reg.listAlerts(0, 100))[0]!.status).toBe("Revoked");
    expect(await reg.check("near", "goldbridge-desk.near")).toBeNull();
  });

  it("a read that started before a write does not repopulate the cache", async () => {
    const { reg, spy } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = spy.getMockImplementation();
    spy.mockImplementationOnce(async (...a) => {
      await gate;
      return (orig ? orig(...a) : []) as never;
    });
    const stale = reg.listAlerts(0, 100);
    reg.invalidate();
    release();
    await stale;
    await reg.listAlerts(0, 100);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    let n = 0;
    const flaky = {
      kind: "chain",
      contractId: "r.test",
      listAlerts: async () => {
        if (n++ === 0) throw new Error("RPC query HTTP 429");
        return [];
      },
    } as unknown as RegistryClient;
    const reg = new CachedRegistryClient(flaky, new TtlCache(4000));
    await expect(reg.listAlerts()).rejects.toThrow(/429/);
    await expect(reg.listAlerts()).resolves.toEqual([]);
  });
});
