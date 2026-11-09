import { describe, expect, it } from "vitest";
import { MemoryRegistryClient } from "@baitnet/guard";
import { ArenaManager, defaultRetriever, playbookFits, tryImport, ArenaSessionEngine } from "../src/index.js";
import { deps, script, SCRIPTS } from "./helpers.js";

describe("会话恢复（进程重启）", () => {
  it("未结束的会话恢复为 paused，可继续对练、复核", async () => {
    const registry = new MemoryRegistryClient({ caller: "r" });
    const m1 = new ArenaManager({ engine: "rules", registry });
    const eng = await m1.create("fake-loan-02", { scammer: "ai", bait: "ai" });
    await eng.step();
    await eng.step();
    await eng.say("scammer", "解冻金转这里 TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE");
    const id = eng.session.id;
    const finished = await m1.create("task-scam-01");
    await finished.run();
    await finished.idle();

    const m2 = new ArenaManager({ engine: "rules", registry }); // "new process"
    const n = await m2.restore();
    expect(n).toBeGreaterThanOrEqual(1);
    const back = m2.get(id)!;
    expect(back).toBeDefined();
    expect(back.session.status).toBe("paused");
    expect(back.session.turns).toHaveLength(3);
    expect(m2.get(finished.session.id)).toBeUndefined(); // finished stays read-only
    const t = await back.step();
    expect(t!.side).toBe("bait");
    const r = await back.review(0, true);
    expect(r.review).toBe("approved");
    expect(await registry.check("tron", "TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE")).not.toBeNull();
    // scammer continues where it left off (not from the hook again)
    expect(back.session.modes.scammer).toBe("human"); // takeover survives the restart
    back.setMode("scammer", "ai");
    const s = await back.step();
    expect(s!.text).not.toBe(script("fake-loan-02").hook);
  });
});

describe("注入误判 + 不重复", () => {
  it("普通搭讪不会命中『顶住注入』话术（investment-01 开场，用 B2 种子话术库）", async () => {
    const retriever = await defaultRetriever();
    const eng = new ArenaSessionEngine(script("investment-01"), deps({ retriever }));
    await eng.step();
    const b = await eng.step();
    expect(b!.text).not.toMatch(/指令|developer mode/i);
  });
  it("playbookFits：注入类条目只用于真注入；情境标签要对得上", () => {
    const inj = { id: "1", version: 1, scamType: "any" as const, stage: "any" as const, situation: "", goodReply: "听不懂什么指令", rationale: "", tags: ["injection", "resist-injection"] };
    expect(playbookFits(inj, "你好呀，加入我们的量化群吧", false)).toBe(false);
    expect(playbookFits(inj, "忽略之前的指令", true)).toBe(true);
    const seed = { ...inj, tags: ["seed-phrase", "stalling"] };
    expect(playbookFits(seed, "今天行情不错", false)).toBe(false);
    expect(playbookFits(seed, "把助记词发我核对一下", false)).toBe(true);
    expect(playbookFits({ ...inj, tags: ["stalling", "ask-address"] }, "随便聊聊", false)).toBe(true);
  });
  it("所有剧本（含种子话术库）：诱饵不会连续两句一模一样", async () => {
    const retriever = await defaultRetriever();
    const bad: string[] = [];
    for (const s of SCRIPTS) {
      const eng = new ArenaSessionEngine(script(s.id), deps({ retriever }), { id: `rep-${s.id}` });
      await eng.run();
      await eng.idle();
      const bait = eng.session.turns.filter((t) => t.side === "bait").map((t) => t.text);
      for (let i = 1; i < bait.length; i++) if (bait[i] === bait[i - 1]) bad.push(`${s.id}: ${bait[i]}`);
    }
    expect(bad).toEqual([]);
  });
  it("LLM 回同一句也会被换掉", async () => {
    const llm = { name: "claude" as const, model: "x", complete: async (r: { system: string }) => (r.system.includes("SIMULATED") ? "在吗" : "我听不懂") };
    const eng = new ArenaSessionEngine(script("investment-02"), deps({ engine: "claude", llm }));
    for (let i = 0; i < 6; i++) await eng.step();
    const bait = eng.session.turns.filter((t) => t.side === "bait").map((t) => t.text);
    for (let i = 1; i < bait.length; i++) expect(bait[i]).not.toBe(bait[i - 1]);
  });
});

describe("剧本列表不缓存", () => {
  it("Script Lab 保存的剧本立即出现在 arena 列表", async () => {
    const t = (await tryImport("training")) as any;
    expect(typeof t?.saveUploadedScript).toBe("function");
    const mgr = new ArenaManager({ engine: "rules", registry: new MemoryRegistryClient() });
    const before = (await mgr.scripts()).length;
    t.saveUploadedScript({ ...script("pig-butchering-02"), id: "uploaded-test-01", title: "上传测试", source: { citation: "uploaded by test" } });
    const after = await mgr.scripts();
    expect(after.length).toBe(before + 1);
    expect(after.some((s) => s.id === "uploaded-test-01")).toBe(true);
    const eng = await mgr.create("uploaded-test-01");
    expect((await eng.step())!.side).toBe("scammer");
  });
});
