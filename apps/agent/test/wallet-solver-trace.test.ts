import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Guard, MemoryHistory, MemoryRegistryClient, SampleAccountInfo } from "@baitnet/guard";
import type { GuardEvent } from "@baitnet/shared";
import { fixturePath } from "../src/paths.js";
import { guardedSign, planPayments, type PaySigner } from "../src/wallet/wallet.js";
import { handleQuote, loadQuoteRequests, chainOfAsset } from "../src/solver/solver.js";
import { l2Drafts, loadExplorerTxs, traceForward } from "../src/trace/trace.js";
import { KnownEntityFilter, loadKnownEntities } from "../src/extract/pipeline.js";

const H = "c".repeat(64);
async function registry() {
  const reg = new MemoryRegistryClient({ caller: "rep.near" });
  await reg.report({ chain: "near", address: "goldbridge-desk.near", evidenceHash: H, level: "L1", category: "investment" });
  await reg.report({ chain: "tron", address: "TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB", evidenceHash: H, level: "L1", category: "pig-butchering" });
  await reg.report({ chain: "near", address: "sketchy-l2.near", evidenceHash: H, level: "L2", category: "trace" });
  return reg;
}

describe("M5 payment agent", () => {
  const task = readFileSync(fixturePath("tasks", "injected-payment.txt"), "utf8").replaceAll("{{MERCHANT}}", "alice-merchant.near");
  it("compromised planner picks up the injected instruction", () => {
    const p = planPayments(task);
    expect(p).toHaveLength(3);
    expect(p.filter((x) => x.injected)).toEqual([expect.objectContaining({ to: "goldbridge-desk.near", amount: "50", asset: "USDC" })]);
  });
  it("guardedSign: block → refused (signer never called), allow → signed, warn → asked-human", async () => {
    const guard = new Guard({ registry: await registry(), history: new MemoryHistory() });
    const signed: string[] = [];
    const signer: PaySigner = async (p) => (signed.push(p.to), { txHash: "tx-" + p.to });
    const events: GuardEvent[] = [];
    for (const p of planPayments(task)) await guardedSign(p, { guard, signer, emit: (e) => events.push(e) });
    expect(events.map((e) => e.action)).toEqual(["signed", "signed", "refused"]);
    expect(signed).toEqual(["alice-merchant.near", "alice-merchant.near"]);
    expect(events[2]!.log.join("\n")).toMatch(/REFUSED to sign/);
    const warn = await guardedSign({ to: "sketchy-l2.near", amount: "1", asset: "NEAR", source: "x", injected: false }, { guard, signer });
    expect(warn.action).toBe("asked-human");
    expect(warn.log.join("\n")).toMatch(/\[human\?\].*\n.*auto-reject/);
    const approved = await guardedSign({ to: "sketchy-l2.near", amount: "1", asset: "NEAR", source: "x", injected: false }, { guard, signer, askHuman: async () => "approve" });
    expect(approved.action).toBe("signed");
  });
  it("on-chain vault failure is reported as refused", async () => {
    const guard = new Guard({ registry: new MemoryRegistryClient() });
    const ev = await guardedSign({ to: "bob.near", amount: "1", asset: "NEAR", source: "x", injected: false }, {
      guard,
      signer: async () => ({ failure: "PAY_BLOCKED", txHash: "t", events: [{ event: "pay_blocked", data: [{ reason: "flagged" }] }] }),
    });
    expect(ev.action).toBe("refused");
    expect(ev.log.join("\n")).toMatch(/pay_blocked/);
  });
});

describe("M6 Intents solver", () => {
  it("refuses quotes whose recipient or refundTo is flagged, quotes the rest", async () => {
    const info = SampleAccountInfo.fromFile(fixturePath("account-meta.json"));
    const guard = new Guard({ registry: await registry(), accountInfo: info });
    const decisions = [];
    for (const q of loadQuoteRequests()) decisions.push(await handleQuote(q, guard));
    expect(decisions.map((d) => `${d.quoteId}:${d.event.action}:${d.event.verdict.kind}`)).toEqual([
      "q-7f3a01:quoted:allow",
      "q-7f3a02:quote-refused:block",
      "q-7f3a03:quote-refused:block",
      "q-7f3a04:quoted:warn",
    ]);
    expect(decisions[1]!.verdicts[0]).toMatchObject({ field: "recipient", verdict: { target: { chain: "tron" } } });
    expect(decisions[2]!.verdicts[1]).toMatchObject({ field: "refundTo", verdict: { kind: "block" } });
  });
  it("maps Intents asset ids to chains", () => {
    expect(chainOfAsset("nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near")).toBe("tron");
    expect(chainOfAsset("nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near")).toBe("evm");
    expect(chainOfAsset("nep141:btc.omft.near")).toBe("btc");
    expect(chainOfAsset("nep141:wrap.near")).toBe("near");
  });
});

describe("M7 trace", () => {
  const known = new KnownEntityFilter(loadKnownEntities());
  it("follows 1Click swaps forward, skips refunds, stops at exchanges", () => {
    const t = traceForward({ chain: "near", address: "goldbridge-desk.near" }, loadExplorerTxs(), { known });
    expect(t.edges.map((e) => `${e.from}→${e.chain}:${e.to}`)).toEqual([
      "goldbridge-desk.near→tron:TWBUfSVjgRGQSENodtV6N1yattFFEHG31X",
      "goldbridge-desk.near→evm:0x602bb2c8cea0504ecf00523cf11f17886664ec82",
      "TWBUfSVjgRGQSENodtV6N1yattFFEHG31X→evm:0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549",
      "0x602bb2c8cea0504ecf00523cf11f17886664ec82→btc:bc1qz8w4hm6vq3c0d7e2kxt5ya9jn4r6sp2fug8lc7",
    ]);
    expect(t.edges.every((e) => e.protocol === "near-intents-1click" && e.amountUsd! > 0)).toBe(true);
    expect(t.exits).toEqual([expect.objectContaining({ name: "Binance 15 (hot wallet)" })]);
    expect(t.downstream.map((d) => d.depth)).toEqual([1, 1, 2]);
    const { drafts } = l2Drafts(t, 0, "trace-0", { seal: false });
    expect(drafts.map((d) => d.level)).toEqual(["L2", "L2", "L2"]);
    expect(new Set(drafts.map((d) => d.evidenceHash)).size).toBe(1);
  });
  it("respects maxDepth and unrelated roots", () => {
    expect(traceForward({ chain: "near", address: "goldbridge-desk.near" }, loadExplorerTxs(), { maxDepth: 1 }).edges).toHaveLength(2);
    expect(traceForward({ chain: "near", address: "nobody.near" }, loadExplorerTxs()).edges).toEqual([]);
  });
});
