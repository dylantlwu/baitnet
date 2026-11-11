import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScriptAnalysis } from "@baitnet/shared";
import { UnconfirmedWarningsError, type OnchainLookup } from "@baitnet/agent";
import { MemoryRegistryClient } from "@baitnet/guard";
import { createMiniRouter, openTrainingDb } from "@baitnet/training";
import { analyzeUpload, registerScriptLabRoutes, reviewAlertDraft, type ReviewedAlertDraft } from "../src/index.js";

const FRESH = "0xebb538b6bc2c2261e0af131502f7911f638bd797";
const PLAIN = "0x1234567890abcdef1234567890abcdef12345678";
const chat = (addrLine: string, doubt = true) =>
  ["骗子：你好，做任务返佣了解一下", "受害者：怎么做", doubt ? "骗子：你回得这么快，你是不是机器人啊？" : "骗子：很简单，先垫付一单", "受害者：不是", `骗子：${addrLine}`, "受害者：好的"].join("\n");
type A = Omit<ScriptAnalysis, "alertDrafts"> & { alertDrafts: ReviewedAlertDraft[] };

async function setup(content: string, onchain?: OnchainLookup) {
  process.env.BAITNET_MODE = "offline";
  const db = openTrainingDb(":memory:");
  const registry = new MemoryRegistryClient({ caller: "reporter.memory" });
  const router = createMiniRouter();
  registerScriptLabRoutes(router, {
    log: () => {},
    dataPath: (...p) => join("/nonexistent", ...p),
    db,
    currentUser: (req) => req.user ?? { id: "expert-li" },
    registry: () => registry,
    ...(onchain ? { onchain, analyze: { onchain } } : {}),
  });
  const a = (await router.dispatch("POST", "/scripts/upload", { filename: "d33.txt", content, encoding: "utf8" })).body as A;
  return { db, registry, router, a };
}

describe("D33 in Script Lab uploads", () => {
  it("analysis carries suspicion-before + chain-mismatch; approve without confirmWarnings → 409, with it → on chain", async () => {
    const { router, registry, a } = await setup(chat(`USDT 走 TRC20，付款地址 ${FRESH}`));
    const i = a.alertDrafts.findIndex((d) => d.address === FRESH);
    expect(a.alertDrafts[i]!.warnings?.map((w) => w.code)).toEqual(["suspicion-before", "chain-mismatch"]);
    expect(a.alertDrafts[i]!.warnings![0]!.detail).toMatch(/^第 3 轮骗子问：「.*机器人.*」$/);
    expect(a.warnings.join()).toMatch(/防混淆警告/);

    const no = await router.dispatch("POST", `/scripts/analyses/${a.id}/review`, { draftIndex: i, approve: true });
    expect(no.status).toBe(409);
    expect((no.body as { error: string }).error).toMatch(/suspicion-before, chain-mismatch/);
    expect(await registry.listAlerts(0, 10)).toEqual([]);
    const still = (await router.dispatch("GET", `/scripts/analyses/${a.id}`)).body as A;
    expect(still.alertDrafts[i]!.review).toBe("pending");

    const yes = await router.dispatch("POST", `/scripts/analyses/${a.id}/review`, { draftIndex: i, approve: true, confirmWarnings: true }, { id: "dylan" } as never);
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ review: "approved", alertId: 0 });
  });

  it("no suspicion, matching network → no warnings, plain approve works", async () => {
    const { router, a } = await setup(chat(`USDT 走 ERC20，付款地址 ${FRESH}`, false));
    expect(a.alertDrafts[0]!.warnings).toBeUndefined();
    expect((await router.dispatch("POST", `/scripts/analyses/${a.id}/review`, { draftIndex: 0, approve: true })).status).toBe(200);
  });

  it("on-chain stub: token → filtered at analysis; contract → warning shown before review", async () => {
    const onchain: OnchainLookup = {
      async kind(t) {
        return t.address === FRESH ? { contract: true, token: true, checked: true, detail: "stub token" } : { contract: true, token: false, checked: true, detail: "stub router" };
      },
    };
    const { router, a } = await setup(chat(`ERC20 付款地址 ${FRESH} 或者 ${PLAIN}`, false), onchain);
    const tok = a.alertDrafts.find((d) => d.address === FRESH)!;
    expect(tok.filteredReason).toMatch(/代币合约/);
    const j = a.alertDrafts.findIndex((d) => d.address === PLAIN);
    expect(a.alertDrafts[j]!.warnings?.map((w) => w.code)).toEqual(["contract"]);
    expect((await router.dispatch("POST", `/scripts/analyses/${a.id}/review`, { draftIndex: j, approve: true })).status).toBe(409);
    const t = a.alertDrafts.indexOf(tok);
    expect((await router.dispatch("POST", `/scripts/analyses/${a.id}/review`, { draftIndex: t, approve: true })).body).toMatchObject({ review: "rejected", filteredReason: expect.stringMatching(/代币合约/) });
  });

  it("a warning first found at review time is stored and asked for even with confirmWarnings: true", async () => {
    const { db, registry, a } = await setup(chat(`ERC20 付款地址 ${PLAIN}`, false));
    expect(a.alertDrafts[0]!.warnings).toBeUndefined();
    const flaky: OnchainLookup = { kind: async () => ({ checked: false, detail: "stub timeout" }) };
    const err = await reviewAlertDraft(a.id, 0, true, { registry, onchain: flaky, confirmWarnings: true }, db).catch((e) => e);
    expect(err).toBeInstanceOf(UnconfirmedWarningsError);
    expect(err.codes).toEqual(["unchecked"]);
    // now the reviewer has seen it: confirming goes through
    const ok = await reviewAlertDraft(a.id, 0, true, { registry, onchain: flaky, confirmWarnings: true }, db);
    expect(ok.draft).toMatchObject({ review: "approved", warnings: [expect.objectContaining({ code: "unchecked" })] });
  });

  it("analyzeUpload default (no BAITNET_ONCHAIN_LOOKUP) does not call fetch", async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      throw new Error("network");
    }) as typeof fetch;
    try {
      process.env.BAITNET_MODE = "offline";
      const a = await analyzeUpload({ filename: "x.txt", content: chat(`ERC20 付款地址 ${PLAIN}`, false), encoding: "utf8", expertId: "e" }, { env: { BAITNET_MODE: "offline" } });
      expect(a.alertDrafts[0]!.warnings).toBeUndefined();
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
