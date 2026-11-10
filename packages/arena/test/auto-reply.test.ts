import { describe, expect, it } from "vitest";
import type { ArenaTypingEvent } from "../src/index.js";
import { fakeLLM, session } from "./helpers.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake LLM that answers after `ms` (so concurrent calls really overlap). */
function slow(ms: number) {
  const f = fakeLLM(() => "");
  let n = 0;
  f.llm.complete = async (req) => {
    f.calls.push({ role: req.system.includes("SIMULATED scammer") ? "scammer" : "bait", req });
    await tick(ms);
    return `回复${++n}：真的吗？那具体怎么操作？`;
  };
  return f;
}

const sides = (turns: { side: string; author: string }[]) => turns.map((t) => `${t.side[0]}${t.author === "human" ? "H" : "A"}`).join(" ");

describe("auto reply after a human line (web say)", () => {
  it("human scammer → the AI decoy answers once by itself, with typing on/off around it", async () => {
    const f = slow(10);
    const { eng } = session("fake-loan-02", { engine: "nearai", llm: f.llm }, { modes: { scammer: "human", bait: "ai" } });
    const typing: ArenaTypingEvent[] = [];
    eng.on("typing", (e: ArenaTypingEvent) => typing.push(e));
    const turn = await eng.say("scammer", "你好，你的贷款已经批下来了", { autoReply: true });
    expect(turn).toMatchObject({ side: "scammer", author: "human" });
    const reply = await eng.lastAutoReply;
    expect(reply).toMatchObject({ side: "bait", author: "ai" });
    expect(sides(eng.session.turns)).toBe("sH bA");
    expect(typing.map((e) => `${e.side}:${e.on}`)).toEqual(["bait:true", "bait:false"]);
    expect(eng.typing).toBeNull();
    expect(f.calls.filter((c) => c.role === "bait")).toHaveLength(1);
  });

  it("AI + whisper counts as AI: it answers too", async () => {
    const { eng } = session("fake-loan-02", {}, { modes: { scammer: "human", bait: "ai+whisper" } });
    await eng.say("scammer", "先交 200 手续费", { autoReply: true });
    await eng.lastAutoReply;
    expect(sides(eng.session.turns)).toBe("sH bA");
  });

  it("human decoy → the AI scammer answers", async () => {
    const { eng } = session("fake-loan-02", {}, { modes: { scammer: "ai", bait: "human" } });
    await eng.step(); // scammer opens
    await eng.say("bait", "你好，请问是哪家公司？", { autoReply: true });
    await eng.lastAutoReply;
    expect(sides(eng.session.turns)).toBe("sA bH sA");
  });

  it("both sides human → nothing is generated", async () => {
    const f = slow(1);
    const { eng } = session("fake-loan-02", { engine: "nearai", llm: f.llm }, { modes: { scammer: "human", bait: "human" } });
    await eng.say("scammer", "你好", { autoReply: true });
    expect(await eng.lastAutoReply).toBeNull();
    expect(sides(eng.session.turns)).toBe("sH");
    expect(f.calls).toHaveLength(0);
  });

  it("without autoReply (Telegram drives its own reply) nothing is generated", async () => {
    const { eng } = session("fake-loan-02", {}, { modes: { scammer: "human", bait: "ai" } });
    await eng.say("scammer", "你好");
    await tick(5);
    expect(sides(eng.session.turns)).toBe("sH");
  });

  it("two lines sent back to back: one answer per line, never two in a row, one LLM call at a time", async () => {
    const f = slow(15);
    let inFlight = 0;
    let maxInFlight = 0;
    const orig = f.llm.complete.bind(f.llm);
    f.llm.complete = async (req) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await orig(req);
      } finally {
        inFlight--;
      }
    };
    const { eng } = session("fake-loan-02", { engine: "nearai", llm: f.llm }, { modes: { scammer: "human", bait: "ai" } });
    const a = eng.say("scammer", "第一句：贷款批了", { autoReply: true });
    const r1 = eng.lastAutoReply;
    const b = eng.say("scammer", "第二句：先交手续费", { autoReply: true });
    await Promise.all([a, b, r1, eng.lastAutoReply]);
    expect(sides(eng.session.turns)).toBe("sH bA sH bA");
    expect(maxInFlight).toBe(1);
    expect(f.calls.filter((c) => c.role === "bait")).toHaveLength(2);
  });

  it("step pressed right after sending does not make the decoy answer twice", async () => {
    const f = slow(15);
    const { eng } = session("fake-loan-02", { engine: "nearai", llm: f.llm }, { modes: { scammer: "human", bait: "ai" } });
    const said = eng.say("scammer", "你好，这里是放款中心", { autoReply: true });
    const stepped = eng.step(); // queued behind the auto reply → finds the human side due → null
    const [, st] = await Promise.all([said, stepped, eng.lastAutoReply]);
    expect(st).toBeNull();
    expect(sides(eng.session.turns)).toBe("sH bA");
    expect(f.calls).toHaveLength(1);
  });

  it("while running, the run loop answers (no extra auto reply)", async () => {
    const { eng } = session("fake-loan-02", {}, { modes: { scammer: "human", bait: "ai" } });
    void eng.run(); // waits for the human scammer
    await eng.say("scammer", "你好，贷款批了", { autoReply: true });
    await eng.lastAutoReply;
    await eng.idle();
    eng.pause();
    const t = eng.session.turns;
    expect(sides(t)).toBe("sH bA");
  });
});
