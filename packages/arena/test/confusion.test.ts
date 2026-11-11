import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UnconfirmedWarningsError, type OnchainLookup } from "@baitnet/agent";
import { MemoryRegistryClient } from "@baitnet/guard";
import { runEval } from "../src/index.js";
import { SCRIPTS, script, session } from "./helpers.js";

const FRESH = "0xebb538b6bc2c2261e0af131502f7911f638bd797";
const human = { modes: { scammer: "human" as const, bait: "human" as const } };

describe("D33 in the arena", () => {
  it("suspicion + TRC20-with-0x → pending draft with warnings; approve needs confirmWarnings", async () => {
    const { eng } = session("pig-butchering-04", {}, human);
    await eng.say("scammer", "Hold on, you always answer so fast. Are you a bot?");
    await eng.say("bait", "haha no, just bored at work");
    await eng.say("scammer", `Send 200 USDT via TRC20 to ${FRESH} , that's the pool wallet.`);
    const i = eng.session.drafts.findIndex((x) => x.address === FRESH);
    const draft = eng.session.drafts[i]!;
    expect(draft.review).toBe("pending");
    expect(draft.warnings?.map((w) => w.code)).toEqual(["suspicion-before", "chain-mismatch"]);
    expect(draft.warnings![0]!.detail).toMatch(/^turn 1: scammer asked ".{0,20}Are you.{0,20}"$/);
    expect(draft.warnings![1]!.detail).toMatch(/TRC20.*0x/);

    const err = await eng.review(i, true, "dylan").catch((e) => e);
    expect(err).toBeInstanceOf(UnconfirmedWarningsError);
    expect(err).toMatchObject({ status: 409, code: "warnings-unconfirmed" });
    expect(err.codes).toEqual(["suspicion-before", "chain-mismatch"]);
    expect(eng.session.drafts[i]!.review).toBe("pending");
    expect(eng.session.drafts[i]!.alertId).toBeUndefined();

    const ok = await eng.review(i, true, "dylan", { confirmWarnings: true });
    expect(ok).toMatchObject({ review: "approved", alertId: expect.any(Number) });
  });

  it("zh warning text; rejecting a warned draft needs no confirmation", async () => {
    const { eng } = session("task-scam-04", {}, human);
    await eng.say("scammer", "你每次回得这么快，你是不是机器人啊？");
    await eng.say("bait", "不是啊");
    await eng.say("scammer", `走波场 TRC20，付款地址 ${FRESH}`);
    const i = eng.session.drafts.findIndex((x) => x.address === FRESH);
    expect(eng.session.drafts[i]!.warnings!.map((w) => w.detail)).toEqual([expect.stringMatching(/^第 1 轮骗子问：「.*机器人.*」$/), expect.stringMatching(/说的是 .*给的却是 0x/)]);
    expect((await eng.review(i, false)).review).toBe("rejected");
  });

  it("on-chain stub: token contract → rejected + filteredReason; contract / unchecked → warnings; passes assetHint", async () => {
    const seen: (string | undefined)[] = [];
    const onchain: OnchainLookup = {
      async kind(t, hint) {
        seen.push(hint);
        if (t.address.endsWith("01")) return { contract: true, token: true, checked: true, detail: "stub token" };
        if (t.address.endsWith("02")) return { contract: true, token: false, checked: true, detail: "stub router" };
        return { checked: false, detail: "stub timeout" };
      },
    };
    const { eng } = session("fake-loan-02", { onchain }, human);
    await eng.say("scammer", `BEP20 付款：0x${"a".repeat(38)}01`);
    await eng.say("bait", "好");
    await eng.say("scammer", `ERC20 再转到 0x${"b".repeat(38)}02 和 0x${"c".repeat(38)}03`);
    const [tok, router, unk] = eng.session.drafts;
    expect(tok).toMatchObject({ review: "rejected", filteredReason: expect.stringMatching(/代币合约/) });
    expect(router!.warnings?.map((w) => w.code)).toEqual(["contract"]);
    expect(unk!.warnings?.map((w) => w.code)).toEqual(["unchecked"]);
    expect(seen[0]).toBe("BEP-20");
  });

  it("default deps never touch the network (lookup off unless BAITNET_ONCHAIN_LOOKUP=on)", async () => {
    const spy = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", spy);
    try {
      const { ArenaManager } = await import("../src/index.js");
      const mgr = new ArenaManager({ engine: "rules", persist: false, registry: new MemoryRegistryClient({ caller: "t" }), env: {} });
      const eng = await mgr.create("fake-loan-02", { scammer: "human", bait: "human" });
      await eng.say("scammer", `转到 ${FRESH}`);
      expect(eng.session.drafts[0]!.warnings).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("eval-auto skips warned drafts: en D33 script extracted but not on chain; zh one counts as poisonFiltered", async () => {
    const r = await runEval({ scripts: [script("pig-butchering-04"), script("task-scam-04"), script("fake-loan-02")], record: false, outDir: mkdtempSync(join(tmpdir(), "d33-eval-")) });
    const en = r.cases.find((c) => c.scriptId === "pig-butchering-04")!;
    expect(en).toMatchObject({ extracted: true, onChain: false });
    expect(en.warnedDrafts).toBeGreaterThanOrEqual(1);
    expect(en.notes.join()).toMatch(/suspicion-before\/chain-mismatch/);
    const zh = r.cases.find((c) => c.scriptId === "task-scam-04")!;
    expect(zh).toMatchObject({ extracted: true, poisonFiltered: true, onChain: false, warnedDrafts: 0 });
    expect(r.cases.find((c) => c.scriptId === "fake-loan-02")).toMatchObject({ onChain: true, warnedDrafts: 0 });
    expect(r.summary).toMatchObject({ warned: 1, poisonTotal: 1, poisonFiltered: 1 });
    expect(SCRIPTS.some((s) => s.id === "task-scam-04" && s.poison?.address.startsWith("0x55d398"))).toBe(true);
  });
});
