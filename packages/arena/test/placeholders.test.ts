import { describe, expect, it } from "vitest";
import type { PlaybookEntry } from "@baitnet/shared";
import { decoyReadyPlaybook, hasPlaceholder, naturalizePlaceholders } from "../src/index.js";
import { fakeLLM, retrieverWith, session } from "./helpers.js";

const entry = (over: Partial<PlaybookEntry>): PlaybookEntry => ({
  id: "pb-x", version: 2, scamType: "any", stage: "any", situation: "对方催转账", goodReply: "好的", rationale: "拖延", tags: ["urgency"], ...over,
});

describe("redaction placeholders never reach the decoy", () => {
  it("zh: vocative names are dropped, other names / PII become natural generic words", () => {
    expect(naturalizePlaceholders("[NAME_1]，我还在考虑，钱不多", "zh")).toBe("我还在考虑，钱不多");
    expect(naturalizePlaceholders("[NAME_1]您好，转到哪个地址？", "zh")).toBe("您好，转到哪个地址？");
    expect(naturalizePlaceholders("好的。[NAME_2]，那我先试试", "zh")).toBe("好的。那我先试试");
    expect(naturalizePlaceholders("我跟[NAME_1]说过了", "zh")).toBe("我跟对方说过了");
    expect(naturalizePlaceholders("打[PHONE_1]没人接", "zh")).toBe("打那个号码没人接");
    expect(naturalizePlaceholders("没有占位符", "zh")).toBe("没有占位符");
  });

  it("en: greetings keep their word, other placeholders become generic phrases", () => {
    expect(naturalizePlaceholders("Hi [NAME_1], which address exactly?", "en")).toBe("Hi, which address exactly?");
    expect(naturalizePlaceholders("[NAME_1], is it TRC20?", "en")).toBe("Is it TRC20?");
    expect(naturalizePlaceholders("Thanks [NAME_1]!", "en")).toBe("Thanks!");
    expect(naturalizePlaceholders("I emailed [EMAIL_1] already", "en")).toBe("I emailed that email already");
  });

  it("decoyReadyPlaybook cleans every field and drops nothing usable", () => {
    const out = decoyReadyPlaybook(
      [entry({ situation: "[NAME_1]让我先充值", badReply: "[NAME_1]，我马上转", goodReply: "[NAME_1]，我还在考虑", rationale: "别答应[NAME_1]" })],
      "zh",
    );
    expect(out).toHaveLength(1);
    for (const f of [out[0]!.situation, out[0]!.badReply, out[0]!.goodReply, out[0]!.rationale]) expect(hasPlaceholder(f)).toBe(false);
    expect(out[0]!.goodReply).toBe("我还在考虑");
  });

  it("LLM decoy prompt: examples carry no [NAME_n]", async () => {
    const { llm, calls } = fakeLLM((_req, role) => (role === "scammer" ? "陈老师在这，先充 300U" : "转到哪个地址？"));
    const { eng } = session("pig-butchering-02", { engine: "claude", llm, retriever: retrieverWith([entry({ goodReply: "[NAME_1]，我还在考虑，钱不多" })]) });
    await eng.step();
    await eng.step();
    const bait = calls.find((c) => c.role === "bait")!;
    expect(bait.req.system).toContain("我还在考虑，钱不多");
    expect(bait.req.system).not.toMatch(/\[NAME_\d+\]/);
  });

  it("rules decoy: a playbook line with a placeholder is said naturally", async () => {
    const { eng } = session("pig-butchering-02", { retriever: retrieverWith([entry({ goodReply: "[NAME_1]，我还在考虑，钱不多，转到哪个地址？", tags: [] })]) });
    for (let i = 0; i < 6; i++) await eng.step();
    for (const t of eng.session.turns.filter((t) => t.side === "bait")) expect(t.text).not.toMatch(/\[[A-Z]+_\d+\]/);
  });
});
