import { describe, expect, it } from "vitest";
import {
  Guard,
  MemoryHistory,
  MemoryRegistryClient,
  SampleAccountInfo,
  CompositeAccountInfo,
  normalizeAddress,
  isValidNearAccount,
  fromRawAlert,
  parseOutcome,
} from "../src/index.js";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const NOW = new Date("2026-11-12T12:00:00Z");
const now = () => NOW;

async function seeded() {
  const reg = new MemoryRegistryClient({ caller: "reporter.test.near", now });
  await reg.report({ chain: "near", address: "goldbridge-desk.near", evidenceHash: H, level: "L1", category: "investment" });
  await reg.report({ chain: "evm", address: "0x7D72774a3c9680e6d2921350f889b48ba2f3b24d", evidenceHash: H2, level: "L2", category: "trace" });
  return reg;
}

describe("normalize", () => {
  it("mirrors contract normalization", () => {
    expect(normalizeAddress("evm", " 0xAbCdEf0123456789abcdef0123456789ABCDEF01 ")).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(normalizeAddress("near", "GoldBridge-Desk.NEAR")).toBe("goldbridge-desk.near");
    expect(normalizeAddress("btc", "BC1QABC")).toBe("bc1qabc");
    expect(normalizeAddress("tron", "TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB")).toBe("TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB");
    expect(() => normalizeAddress("evm", "0x123")).toThrow();
    expect(isValidNearAccount("a..b")).toBe(false);
    expect(isValidNearAccount("alice.near")).toBe(true);
  });
  it("maps raw contract JSON", () => {
    const v = fromRawAlert({
      id: 3, chain: "near", address: "x.near", level: "L1", category: "c", evidence_hash: H,
      status: "Active", reporter: "r.near", created_at: "1700000000000000000",
    });
    expect(v.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(v.evidenceHash).toBe(H);
  });
});

describe("Guard signals", () => {
  it("signal 1: Active L1 in registry → block", async () => {
    const g = new Guard({ registry: await seeded(), now });
    const v = await g.check({ chain: "near", address: "GOLDBRIDGE-DESK.near" });
    expect(v.kind).toBe("block");
    expect(v.reasons[0]!.signal).toBe("registry-l1");
    expect(v.alert?.id).toBe(0);
  });

  it("signal 2: L2 or Disputed → warn", async () => {
    const reg = await seeded();
    const g = new Guard({ registry: reg, now });
    const v = await g.check({ chain: "evm", address: "0x7d72774a3c9680e6d2921350f889b48ba2f3b24d" });
    expect(v.kind).toBe("warn");
    expect(v.reasons.map((r) => r.signal)).toEqual(["registry-l2-or-disputed"]);
    await reg.setStatus(0, "Disputed");
    const g2 = new Guard({ registry: reg, now });
    expect((await g2.check({ chain: "near", address: "goldbridge-desk.near" })).kind).toBe("warn");
  });

  it("signal 3: young account → warn", async () => {
    const info = new SampleAccountInfo([{ chain: "evm", address: "0x252a0c2b43e446365178b08c444d369ec80d03c9", ageDays: 2 }], now);
    const g = new Guard({ registry: new MemoryRegistryClient(), accountInfo: info, now });
    const v = await g.check({ chain: "evm", address: "0x252A0c2b43e446365178b08c444d369ec80d03c9" });
    expect(v.kind).toBe("warn");
    expect(v.reasons[0]!.signal).toBe("young-account");
    const old = await g.check({ chain: "near", address: "unknown.near" });
    expect(old.kind).toBe("allow");
  });

  it("signal 4: contract code changed within 24h → warn", async () => {
    const info = new CompositeAccountInfo([
      new SampleAccountInfo([], now),
      new SampleAccountInfo([{ chain: "near", address: "swap-router-v2.near", ageDays: 400, codeChangedHoursAgo: 3 }], now),
    ]);
    const g = new Guard({ registry: new MemoryRegistryClient(), accountInfo: info, now });
    const v = await g.check({ chain: "near", address: "swap-router-v2.near" });
    expect(v.kind).toBe("warn");
    expect(v.reasons.map((r) => r.signal)).toEqual(["contract-code-changed"]);
    const info2 = new SampleAccountInfo([{ chain: "near", address: "r.near", codeChangedHoursAgo: 30 }], now);
    const g2 = new Guard({ registry: new MemoryRegistryClient(), accountInfo: info2, now });
    expect((await g2.check({ chain: "near", address: "r.near" })).kind).toBe("allow");
  });

  it("signal 5: no prior interaction → low-weight reason (allow by default, warn with strict threshold)", async () => {
    const history = new MemoryHistory();
    const g = new Guard({ registry: new MemoryRegistryClient(), history, now });
    const t = { chain: "near" as const, address: "alice-merchant.near" };
    const v = await g.check(t);
    expect(v.reasons.map((r) => r.signal)).toEqual(["no-prior-interaction"]);
    expect(v.kind).toBe("allow");
    const strict = new Guard({ registry: new MemoryRegistryClient(), history, warnThreshold: 0.1, now });
    expect((await strict.check(t)).kind).toBe("warn");
    await g.recordInteraction(t);
    expect((await g.check(t)).reasons).toEqual([]);
  });

  it("young + no-history combine to warn", async () => {
    const info = new SampleAccountInfo([{ chain: "tron", address: "TWBUfSVjgRGQSENodtV6N1yattFFEHG31X", ageDays: 6 }], now);
    const g = new Guard({ registry: new MemoryRegistryClient(), accountInfo: info, history: new MemoryHistory(), now });
    const v = await g.check({ chain: "tron", address: "TWBUfSVjgRGQSENodtV6N1yattFFEHG31X" });
    expect(v.kind).toBe("warn");
    expect(v.reasons).toHaveLength(2);
  });
});

describe("Guard cache + incremental sync", () => {
  it("syncs incrementally with a cursor and answers from local cache fast", async () => {
    const reg = await seeded();
    const calls: number[] = [];
    const spy = new Proxy(reg, {
      get(t, p) {
        if (p === "listAlerts") return (from: number, lim: number) => (calls.push(from), t.listAlerts(from, lim));
        if (p === "check") throw new Error("guard must not send the target to the registry");
        return (t as any)[p];
      },
    });
    const g = new Guard({ registry: spy, now, fullResyncEvery: 0 });
    await g.sync();
    expect(g.syncCursor).toBe(2);
    await reg.report({ chain: "tron", address: "TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB", evidenceHash: H, level: "L1", category: "pig-butchering" });
    await g.sync();
    expect(calls).toEqual([0, 2]);
    expect(g.cacheSize).toBe(3);
    const t0 = performance.now();
    const v = await g.check({ chain: "tron", address: "TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB" });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(v.kind).toBe("block");
  });

  it("full resync drops revoked alerts", async () => {
    const reg = await seeded();
    const g = new Guard({ registry: reg, now, fullResyncEvery: 1 });
    await g.sync();
    await reg.setStatus(0, "Revoked");
    await g.sync();
    expect((await g.check({ chain: "near", address: "goldbridge-desk.near" })).kind).toBe("allow");
  });
});

describe("MemoryRegistryClient semantics", () => {
  it("appends evidence to an existing Active alert and raises level", async () => {
    const reg = new MemoryRegistryClient({ caller: "r.near" });
    const a = await reg.report({ chain: "evm", address: "0x602bb2c8cea0504ecf00523cf11f17886664ec82", evidenceHash: H, level: "L2", category: "trace" });
    const b = await reg.report({ chain: "evm", address: "0x602BB2c8cea0504ecf00523cf11f17886664ec82", evidenceHash: H2, level: "L1", category: "trace" });
    expect(b.value).toBe(a.value);
    expect((await reg.getAlert(a.value))!.level).toBe("L1");
  });
  it("rejects non-reporters and enforces responder registration for ack", async () => {
    const reg = new MemoryRegistryClient({ caller: "r.near", reporters: [] });
    await expect(reg.report({ chain: "near", address: "x.near", evidenceHash: H, level: "L1", category: "c" })).rejects.toThrow("ERR_NOT_REPORTER");
    const ok = new MemoryRegistryClient({ caller: "r.near" });
    const { value: id } = await ok.report({ chain: "near", address: "x.near", evidenceHash: H, level: "L1", category: "c" });
    const wallet = ok.as("wallet.near");
    await expect(wallet.ack(id, "Blocked")).rejects.toThrow("ERR_NOT_RESPONDER");
    await wallet.registerResponder("DemoWallet");
    await wallet.ack(id, "Blocked");
    expect(await ok.getAcks(id)).toMatchObject([{ responder: "wallet.near", outcome: "Blocked" }]);
    expect(await ok.listResponders()).toHaveLength(1);
  });
  it("check hides L3", async () => {
    const reg = new MemoryRegistryClient({ caller: "r.near" });
    await reg.report({ chain: "near", address: "c.near", evidenceHash: H, level: "L3", category: "cluster" });
    expect(await reg.check("near", "c.near")).toBeNull();
  });
});

describe("parseOutcome", () => {
  it("extracts return value, tx hash, NEP-297 events and failures", () => {
    const ev = { standard: "baitnet", version: "1.0.0", event: "report", data: [{ alert_id: 0 }] };
    const out = parseOutcome<number>({
      transaction: { hash: "TxHash1" },
      status: { SuccessValue: Buffer.from("7").toString("base64") },
      transaction_outcome: { outcome: { logs: [] } },
      receipts_outcome: [{ outcome: { logs: ["EVENT_JSON:" + JSON.stringify(ev)], status: {} } }],
    });
    expect(out).toMatchObject({ value: 7, txHash: "TxHash1", events: [ev] });
    const bad = parseOutcome({ transaction: { hash: "x" }, status: {}, receipts_outcome: [{ outcome: { logs: [], status: { Failure: { ActionError: "ERR_BLOCKED" } } } }] });
    expect(bad.failure).toContain("ERR_BLOCKED");
  });
});
