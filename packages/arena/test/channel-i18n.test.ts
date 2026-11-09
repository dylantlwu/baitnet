import { describe, expect, it } from "vitest";
import type { ArenaEvent } from "@baitnet/shared";
import { MemoryRegistryClient } from "@baitnet/guard";
import { ArenaManager, langFromAcceptLanguage, readLatestReport, runEval } from "../src/index.js";
import { fakeLLM, session } from "./helpers.js";

describe("SessionChannel + owner", () => {
  it("channel 写进会话 JSON，重启恢复后还在；listByOwner 只列本人", async () => {
    const registry = new MemoryRegistryClient({ caller: "r" });
    const m1 = new ArenaManager({ engine: "rules", registry });
    const a = await m1.create("pig-butchering-02", {}, { kind: "telegram", chatId: "777", ownerId: "u_wang", expertPlays: "scammer" });
    await m1.create("investment-01", {}, { kind: "web", ownerId: "u_li" });
    await a.step();
    const m2 = new ArenaManager({ engine: "rules", registry });
    await m2.restore();
    expect(m2.get(a.session.id)!.session.channel).toEqual({ kind: "telegram", chatId: "777", ownerId: "u_wang", expertPlays: "scammer" });
    expect(m2.listByOwner("u_wang").map((s) => s.id)).toEqual([a.session.id]);
    expect(m2.listByOwner("u_li")).toHaveLength(1);
  });
});

describe("每日大模型额度", () => {
  it("超出额度：会话降级成规则模式，发 safety 事件 llm-quota-exceeded", async () => {
    let left = 2;
    const { llm, calls } = fakeLLM((_r, role) => (role === "scammer" ? "你好呀" : "你好，你是？"));
    const mgr = new ArenaManager({ engine: "claude", llm, registry: new MemoryRegistryClient({ caller: "r" }), persist: false, llmQuota: () => left-- > 0 });
    const eng = await mgr.create("pig-butchering-02", {}, { kind: "telegram", chatId: "1", ownerId: "u_wang" });
    const ev: ArenaEvent[] = [];
    eng.on("event", (e) => ev.push(e));
    await eng.step();
    await eng.step();
    expect(eng.session.engine).toBe("claude");
    const t = await eng.step();
    expect(t).not.toBeNull();
    expect(eng.session.engine).toBe("rules");
    expect(ev.find((e) => e.type === "safety")).toMatchObject({ rule: "llm-quota-exceeded" });
    expect(calls).toHaveLength(2);
    await eng.step();
    expect(calls).toHaveLength(2); // no more LLM calls after downgrade
  });
});

describe("i18n（中文优先）", () => {
  it.each([
    [undefined, "zh"],
    ["zh-CN,zh;q=0.9,en;q=0.8", "zh"],
    ["en-US,en;q=0.9", "en"],
    ["en-US;q=0.8,zh-CN;q=0.9", "zh"],
    ["fr-FR,fr;q=0.9", "zh"],
    ["ja,en;q=0.5", "en"],
  ])("Accept-Language %s → %s", (h, out) => {
    expect(langFromAcceptLanguage(h as string | undefined)).toBe(out);
  });

  it("中文剧本里投毒地址的过滤原因是中文", async () => {
    const { eng } = session("fake-airdrop-01", {}, { modes: { scammer: "human", bait: "ai" } });
    await eng.say("scammer", "先转到币安地址 0x28C6c06298d514Db089934071355E5743bf21d60");
    expect(eng.session.drafts[0]!.filteredReason).toMatch(/^已知机构地址：Binance 14（交易所热钱包）/);
  });

  it("成绩单备注：默认中文，lang=en 时英文", async () => {
    await runEval({ record: false, maxTurns: 8 });
    const zh = readLatestReport()!;
    const en = readLatestReport(undefined, "en")!;
    const i = zh.cases.findIndex((c) => c.notes.length);
    expect(zh.cases[i]!.notes.join("")).toMatch(/[一-鿿]/);
    expect(en.cases[i]!.notes.join("")).not.toMatch(/[一-鿿]/);
  });
});
