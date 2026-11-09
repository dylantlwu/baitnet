import { describe, expect, it } from "vitest";
import { MemoryRegistryClient, SampleAccountInfo } from "@baitnet/guard";
import { AccountAgeCheck, KnownEntityFilter, loadKnownEntities, processConversation, reportDrafts } from "../src/extract/pipeline.js";
import { ReplayProvider } from "../src/llm/provider.js";

const replay = new ReplayProvider();
const known = new KnownEntityFilter(loadKnownEntities());

describe("M2 pipeline", () => {
  it("filters known entities, logs review, reports only approved drafts", async () => {
    const age = new AccountAgeCheck(new SampleAccountInfo([]));
    const r = await processConversation(replay.fixture("pig-butchering"), { known, age });
    const binance = r.drafts.find((d) => d.address.startsWith("0x28C6"))!;
    expect(binance.filteredReason).toMatch(/known-entity: Binance/);
    expect(r.log.some((l) => l.startsWith("[review] L1 tron:TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB → APPROVED"))).toBe(true);
    const reg = new MemoryRegistryClient({ caller: "rep.near" });
    const out = await reportDrafts(reg, r.drafts);
    expect(out.map((o) => o.draft.address)).toEqual(["TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB"]);
    expect((await reg.check("evm", "0x28C6c06298d514Db089934071355E5743bf21d60"))).toBeNull();
    expect(out[0]!.draft.level).toBe("L1");
  });
  it("holds long-lived/active accounts for review (anti-poisoning)", async () => {
    const age = new AccountAgeCheck(new SampleAccountInfo([{ chain: "near", address: "goldbridge-desk.near", ageDays: 2000 }]));
    const r = await processConversation(replay.fixture("investment"), { known, age });
    expect(r.drafts.find((d) => d.address === "goldbridge-desk.near")!.filteredReason).toMatch(/age-activity/);
    expect(r.drafts.find((d) => d.address === "usdt.tether-token.near")!.filteredReason).toMatch(/known-entity/);
  });
  it("a rejecting reviewer stops the report", async () => {
    const r = await processConversation(replay.fixture("fake-support"), {
      known,
      age: new AccountAgeCheck(new SampleAccountInfo([])),
      reviewer: async () => ({ approved: false, reviewer: "dylan", note: "insufficient evidence" }),
    });
    expect(r.drafts.every((d) => d.filteredReason?.startsWith("review-rejected"))).toBe(true);
    expect(await reportDrafts(new MemoryRegistryClient({ caller: "x.near" }), r.drafts)).toEqual([]);
  });
});
