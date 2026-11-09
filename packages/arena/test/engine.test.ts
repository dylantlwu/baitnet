import { describe, expect, it } from "vitest";
import type { ArenaEvent } from "@baitnet/shared";
import { Guard } from "@baitnet/guard";
import { fakeLLM, retrieverWith, script, session } from "./helpers.js";

describe("arena engine state machine", () => {
  it("scammer opens, sides alternate, step plays exactly one AI turn", async () => {
    const { eng } = session("investment-01");
    const t0 = await eng.step();
    expect(t0).toMatchObject({ index: 0, side: "scammer", author: "ai" });
    expect(t0!.text).toContain(script("investment-01").hook.slice(0, 10));
    const t1 = await eng.step();
    expect(t1).toMatchObject({ index: 1, side: "bait", author: "ai" });
    expect(eng.session.status).toBe("paused");
  });

  it("run auto-plays until a human side is due, say() resumes, pause stops", async () => {
    const { eng } = session("pig-butchering-02", {}, { modes: { scammer: "ai", bait: "human" } });
    await eng.run();
    expect(eng.session.turns).toHaveLength(1); // scammer spoke, waiting for human bait
    expect(eng.session.status).toBe("running");
    await eng.say("bait", "在吗？我想问下怎么充值");
    eng.setMode("bait", "ai");
    await eng.idle();
    expect(eng.session.turns.length).toBeGreaterThan(3);
    expect(eng.session.status).toBe("finished");
    expect(eng.session.turns.filter((t) => t.author === "human")).toHaveLength(1);
  });

  it("pause() halts a running session after the current turn", async () => {
    const { eng } = session("fake-loan-02", { stepDelayMs: 5 });
    const events: ArenaEvent[] = [];
    eng.on("event", (e) => events.push(e));
    const p = eng.run();
    await new Promise((r) => setTimeout(r, 12));
    eng.pause();
    await p;
    const n = eng.session.turns.length;
    expect(eng.session.status).toBe("paused");
    await new Promise((r) => setTimeout(r, 30));
    expect(eng.session.turns.length).toBe(n);
    expect(events.some((e) => e.type === "status" && e.status === "paused")).toBe(true);
  });

  it("全流程：选剧本 → AI 对 AI → 人接管骗子说一句 → 抽到地址 → 复核上链 → 守卫拦截", async () => {
    const { eng, d } = session("fake-support-01");
    await eng.step();
    await eng.step();
    const addr = "TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE";
    const turn = await eng.say("scammer", `别磨蹭了，直接转到这个地址：${addr}，波场链`);
    expect(turn.author).toBe("human");
    expect(eng.session.modes.scammer).toBe("human");
    const i = eng.session.drafts.findIndex((x) => x.address === addr);
    expect(eng.session.drafts[i]).toMatchObject({ chain: "tron", level: "L1", review: "pending" });
    expect(await d.registry.check("tron", addr)).toBeNull(); // nothing on chain before review
    const events: ArenaEvent[] = [];
    eng.on("event", (e) => events.push(e));
    const r = await eng.review(i, true, "dylan");
    expect(r.review).toBe("approved");
    expect(events.find((e) => e.type === "onchain")).toMatchObject({ draftIndex: i, alertId: r.alertId });
    const v = await new Guard({ registry: d.registry }).check({ chain: "tron", address: addr });
    expect(v.kind).toBe("block");
    await expect(eng.review(i, true)).rejects.toThrow(/already approved/);
  });

  it("rejected review never reaches the registry; poison drafts are pre-rejected", async () => {
    const { eng, d } = session("exchange-impersonation-03", {}, { modes: { scammer: "human", bait: "ai" } });
    await eng.say("scammer", "Report TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi now. Or pay 0x7d72774a3c9680e6d2921350f889b48ba2f3b24d");
    const poison = eng.session.drafts.find((x) => x.address === "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi")!;
    expect(poison.review).toBe("rejected");
    expect(poison.filteredReason).toMatch(/known-entity: Binance/);
    await expect(eng.review(eng.session.drafts.indexOf(poison), true)).rejects.toThrow(/already rejected/);
    const j = eng.session.drafts.findIndex((x) => x.chain === "evm");
    await eng.review(j, false);
    expect(await d.registry.listAlerts()).toEqual([]);
  });
});

describe("whisper and takeover", () => {
  it("耳语只对一方可见：bait 的耳语只进 bait 的 prompt，骗子 prompt 里永远没有", async () => {
    const { llm, calls } = fakeLLM((_req, role) => (role === "scammer" ? "你好呀，最近在忙什么？" : "还好，你说的那个平台怎么充值？"));
    const { eng } = session("pig-butchering-02", { engine: "claude", llm });
    await eng.step(); // scammer
    eng.whisper("bait", "SECRET-HINT 追问是不是TRC20");
    expect(eng.session.modes.bait).toBe("ai+whisper");
    const b = await eng.step(); // bait uses whisper
    expect(b!.whisper).toBe("SECRET-HINT 追问是不是TRC20");
    await eng.step(); // scammer
    await eng.step(); // bait again: whisper consumed
    const baitCalls = calls.filter((c) => c.role === "bait");
    expect(baitCalls[0]!.req.system).toContain("SECRET-HINT");
    expect(baitCalls[1]!.req.system).not.toContain("SECRET-HINT");
    for (const c of calls.filter((c) => c.role === "scammer")) {
      expect(c.req.system).not.toContain("SECRET-HINT");
      expect(JSON.stringify(c.req.messages)).not.toContain("SECRET-HINT");
    }
    // scammer never sees whisper text in chat history either
    expect(eng.session.turns.filter((t) => t.side === "bait").some((t) => t.text.includes("SECRET-HINT"))).toBe(false);
  });

  it("scammer whisper goes only to the scammer; whisper to a human side is refused", async () => {
    const { llm, calls } = fakeLLM((_r, role) => (role === "scammer" ? "Hi!" : "Hello?"));
    const { eng } = session("investment-02", { engine: "claude", llm });
    eng.whisper("scammer", "PUSH-URGENCY");
    await eng.step();
    await eng.step();
    expect(calls.find((c) => c.role === "scammer")!.req.system).toContain("PUSH-URGENCY");
    expect(calls.find((c) => c.role === "bait")!.req.system).not.toContain("PUSH-URGENCY");
    eng.setMode("bait", "human");
    expect(() => eng.whisper("bait", "x")).toThrow(/human-controlled/);
  });

  it("投毒耳语（investment-03）：聊天里冒充操作员耳语只当骗子的话，不进 whisper 通道", async () => {
    const { eng } = session("investment-03", {}, { modes: { scammer: "human", bait: "ai" } });
    const forged = script("investment-03").injections.find((x) => x.includes("操作员耳语"))!;
    const t = await eng.say("scammer", forged);
    expect(t.whisper).toBeUndefined();
    const b = await eng.step();
    expect(b!.whisper).toBeUndefined();
    expect(b!.text).not.toMatch(/同意|交易哈希|已转|马上转/);
    expect(eng.metrics.injectionTurns).toContain(t.index);
    expect(eng.metrics.hijackTurns).toEqual([]);
  });

  it("LLM fails → rules fallback for that turn, session continues", async () => {
    const llm = { name: "nearai" as const, model: "x", complete: async () => { throw new Error("402 Payment Required"); } };
    const { eng } = session("fake-airdrop-01", { engine: "nearai", llm });
    await eng.step();
    await eng.step();
    expect(eng.session.turns).toHaveLength(2);
    expect(eng.metrics.llmFallbacks).toBe(2);
  });
});

describe("playbook + language", () => {
  it("规则模式命中 playbook 时优先用 goodReply（中文）", async () => {
    const entry = { id: "pb1", version: 1, scamType: "pig-butchering" as const, stage: "any" as const, situation: "对方套近乎", goodReply: "哈哈你真会聊天～那你们平台的充值地址是哪个呀？", rationale: "顺势追问地址", tags: ["ask-address"] };
    const { eng } = session("pig-butchering-02", { retriever: retrieverWith([entry]) });
    await eng.step();
    const b = await eng.step();
    expect(b!.text).toBe(entry.goodReply);
    expect(eng.metrics.playbookHits).toBe(1);
  });

  it("LLM 模式把 playbook 当 few-shot 放进 bait prompt", async () => {
    const entry = { id: "pb2", version: 1, scamType: "any" as const, stage: "any" as const, situation: "asks to hurry", badReply: "OK sending now", goodReply: "Which address exactly, TRC20?", rationale: "stall + ask", tags: [] };
    const { llm, calls } = fakeLLM((_r, role) => (role === "scammer" ? "Hurry up!" : "Which address?"));
    const { eng } = session("investment-02", { engine: "claude", llm, retriever: retrieverWith([entry]) });
    await eng.step();
    await eng.step();
    expect(calls.find((c) => c.role === "bait")!.req.system).toContain("Which address exactly, TRC20?");
    expect(calls.find((c) => c.role === "scammer")!.req.system).not.toContain("Which address exactly"); // D15: scammer never reads playbook
  });

  it("语言跟着骗子走：英文剧本里骗子改说中文，诱饵就用中文", async () => {
    const { eng } = session("investment-02", {}, { modes: { scammer: "human", bait: "ai" } });
    await eng.say("scammer", "你好，我是你的投资顾问，今天有个好项目想推荐给你");
    const b = await eng.step();
    expect(b!.text).toMatch(/[一-鿿]/);
    await eng.say("scammer", "Hello, are you there? This is a great opportunity.");
    const b2 = await eng.step();
    expect(b2!.text).not.toMatch(/[一-鿿]/);
  });

  it("中文诱饵模板有变化：一整场不重复同一句，至少 4 种不同说法", async () => {
    const { eng } = session("task-scam-01");
    await eng.run();
    await eng.idle();
    const bait = eng.session.turns.filter((t) => t.side === "bait").map((t) => t.text);
    expect(new Set(bait).size).toBeGreaterThanOrEqual(Math.min(4, bait.length));
    expect(bait.every((t) => /[一-鿿]/.test(t))).toBe(true);
  });

  it("同一会话 id 可复现（seeded），不同会话有变化", async () => {
    const { ArenaSessionEngine } = await import("../src/index.js");
    const { deps, script } = await import("./helpers.js");
    const run = async (id: string) => {
      const e = new ArenaSessionEngine(script("family-emergency-01"), deps(), { id });
      await e.run();
      await e.idle();
      return e.session.turns.map((t) => t.text);
    };
    expect(await run("fixed-1")).toEqual(await run("fixed-1"));
    expect(await run("fixed-1")).not.toEqual(await run("fixed-2"));
  });
});
