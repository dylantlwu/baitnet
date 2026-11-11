import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArenaSession, ScamScriptDef, ScammerCard, ScammerMind } from "@baitnet/shared";
import {
  ArenaManager,
  ArenaSessionEngine,
  SUSPICION_WEIGHTS,
  baitSystemPrompt,
  initScammerMind,
  loadScammerCards,
  parseScammerOutput,
  scammerStance,
  scammerSystemPrompt,
  scoreSession,
  selectScammerCard,
  stripWithheld,
  summarize,
  suspicionFromBait,
  updateScammerMind,
  withoutDecoyMind,
  withoutHiddenMinds,
} from "../src/index.js";
import { deps, fakeLLM } from "./helpers.js";

// ------------------------------------------------------------------ inline test data (no fixtures needed)
const CARD: ScammerCard = {
  id: "zh-test-rookie",
  lang: "zh",
  handle: "CARD-HANDLE-阿飞",
  age: 23,
  fitsScamTypes: ["investment", "fake-loan"],
  situation: "CARD-SITUATION 园区三楼",
  pressure: "CARD-PRESSURE 业绩不够要罚站",
  scriptDiscipline: "CARD-DISCIPLINE 照话术念",
  slips: ["CARD-SLIP 时差说漏"],
  suspicionTriggers: ["CARD-TRIGGER 问得太细"],
  tests: ["你发个语音给我听听呗", "拍张手写今天日期的照片我看看"],
  onSuspicion: ["CARD-ONSUS 换地址"],
  limits: ["CARD-LIMIT 不视频"],
  voice: { style: "CARD-VOICE 油滑", catchphrases: ["CARD-CATCH 亲"], quirks: ["CARD-QUIRK 错别字"] },
};
const CARD2: ScammerCard = { ...CARD, id: "zh-test-boss", handle: "老K" };
const EN_CARD: ScammerCard = { ...CARD, id: "en-test", lang: "en", handle: "Ricky" };

const ADDR = "TXw3qgwGRUvY6V3YbwPj3EhsGmL1q8V2Ft";
const POISON = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi"; // known Binance Tron hot wallet (fixtures/known-entities.json)

function testScript(over: Partial<ScamScriptDef> = {}): ScamScriptDef {
  return {
    id: "d34-test",
    type: "investment",
    lang: "zh",
    title: "测试",
    persona: "自称投资导师陈老师",
    hook: "你好，我是陈老师，带你做量化。",
    goal: "让对方充 USDT",
    stages: [
      { name: "接近", objective: "拉关系", sampleLines: ["最近行情很好", "我带的学员都赚了"] },
      { name: "付款", objective: "给地址", sampleLines: [`充值地址 ${ADDR} 波场`, "转完截图给我"] },
      { name: "收割", objective: "催", sampleLines: ["快点吧", "名额不多"] },
    ],
    objections: [],
    plantedArtifacts: [{ kind: "address", chain: "tron", value: ADDR, revealAtStage: 1 }],
    injections: [],
    cover: { name: "COVER-陈博文", age: 38, job: "量化导师", location: "新加坡", backstory: "COVER-STORY 在新加坡做量化十年", people: ["COVER-PERSON 助理小美"], props: ["COVER-PROP 收益截图"], cannotDo: ["COVER-CANNOT 在开会不方便视频"] },
    source: "original",
    ...over,
  };
}

const sj = (score: number, o: Record<string, unknown> = {}) => JSON.stringify({ think: "SM-THINK 观察", bait_suspicion: { score, signals: ["秒回"] }, plan: "SM-PLAN 下一步", action: null, new_facts: [], reply: "亲，在吗", ...o });

function llmSession(scores: number[], opts: { script?: ScamScriptDef; mode?: "easy" | "real"; scammerReply?: (n: number) => string } = {}) {
  let n = 0;
  const f = fakeLLM((_req, role) => {
    if (role === "bait") return JSON.stringify({ think: "BAIT-THINK", scammer_ai: { score: 10, signals: [] }, plan: "p", intel: {}, new_facts: [], reply: "那我转到哪里呀" });
    const i = n++;
    return sj(scores[Math.min(i, scores.length - 1)]!, { reply: opts.scammerReply?.(i) ?? `亲，第${i}句`, new_facts: [`SM-FACT-${i}`] });
  });
  const eng = new ArenaSessionEngine(opts.script ?? testScript(), deps({ engine: "claude", llm: f.llm }), { scammerCard: CARD, scammerMode: opts.mode ?? "real" });
  return { eng, calls: f.calls };
}

async function steps(eng: ArenaSessionEngine, k: number) {
  for (let i = 0; i < k; i++) await eng.step();
}

describe("D34 骗子人物卡：加载与选择", () => {
  it("missing fixtures dir → no cards; malformed entries skipped", () => {
    expect(loadScammerCards("zh", "/nonexistent/scammers")).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "scammers-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "zh.json"), JSON.stringify([CARD, { id: "broken" }, EN_CARD]));
    expect(loadScammerCards("zh", dir).map((c) => c.id)).toEqual(["zh-test-rookie"]);
    writeFileSync(join(dir, "en.json"), "{not json");
    expect(loadScammerCards("en", dir)).toEqual([]);
  });
  it("scammerId pins; else fitsScamTypes ∋ type by hash (stable); else the language's first card", () => {
    const cards = [CARD, CARD2, EN_CARD];
    expect(selectScammerCard({ type: "investment", lang: "zh", scammerId: "zh-test-boss" }, "s1", cards)!.id).toBe("zh-test-boss");
    expect(selectScammerCard({ type: "investment", lang: "zh", scammerId: "en-test" }, "s1", cards)!.lang).toBe("zh"); // wrong language → ignored
    const picks = new Set(Array.from({ length: 30 }, (_, i) => selectScammerCard({ type: "investment", lang: "zh" }, `arena-${i}`, cards)!.id));
    expect([...picks].sort()).toEqual(["zh-test-boss", "zh-test-rookie"]);
    expect(selectScammerCard({ type: "investment", lang: "zh" }, "same", cards)!.id).toBe(selectScammerCard({ type: "investment", lang: "zh" }, "same", cards)!.id);
    expect(selectScammerCard({ type: "otc-mule", lang: "zh" }, "x", cards)!.id).toBe("zh-test-rookie");
    expect(selectScammerCard({ type: "otc-mule", lang: "en" }, "x", [CARD])).toBeUndefined();
  });
  it("session snapshots card + cover; no card → pre-D34 scammer (plain prompt, no mind)", async () => {
    const eng = new ArenaSessionEngine(testScript(), deps(), { scammerCard: CARD, scammerMode: "real" });
    expect(eng.session.scammer!.card.id).toBe(CARD.id);
    expect(eng.session.scammer!.cover!.name).toBe("COVER-陈博文");
    expect(eng.session.scammerMind).toEqual(initScammerMind(CARD));
    expect(eng.session.scammerMode).toBe("real");
    const f = fakeLLM((_r, role) => (role === "scammer" ? "你好呀" : "你好"));
    const plain = new ArenaSessionEngine(testScript(), deps({ engine: "claude", llm: f.llm }), { scammerCard: null, scammerMode: "real" });
    expect(plain.session.scammer).toBeUndefined();
    await plain.step();
    expect(plain.session.scammerMind).toBeUndefined();
    expect(plain.session.turns[0]!.scammerMind).toBeUndefined();
    expect(f.calls[0]!.req.system).not.toContain("[Output format]");
    expect(f.calls[0]!.req.messages).toEqual([{ role: "user", content: "(Start the conversation with your opening hook.)" }]);
    expect(plain.session.turns[0]!.text).toBe("你好呀");
  });
  it("manager: default real, eval-style default easy, bad mode → 400", async () => {
    const mgr = new ArenaManager({ ...deps(), persist: false, scripts: [testScript()] });
    expect((await mgr.create("d34-test")).session.scammerMode).toBe("real");
    expect((await mgr.create("d34-test", {}, undefined, undefined, undefined, "easy")).session.scammerMode).toBe("easy");
    await expect(mgr.create("d34-test", {}, undefined, undefined, undefined, "hard" as never)).rejects.toMatchObject({ status: 400 });
    const evalMgr = new ArenaManager({ ...deps(), persist: false, scripts: [testScript()], scammerMode: "easy" });
    expect((await evalMgr.create("d34-test")).session.scammerMode).toBe("easy");
  });
});

describe("D34 JSON 输出解析 parseScammerOutput", () => {
  it("JSON, fenced, prose around it; action validated; numeric suspicion accepted", () => {
    const o = parseScammerOutput("好的```json\n" + sj(70, { action: "test", new_facts: ["我在新加坡"] }) + "\n```");
    expect(o.reply).toBe("亲，在吗");
    expect(o.mind).toEqual({ think: "SM-THINK 观察", plan: "SM-PLAN 下一步", action: "test" });
    expect(o.suspicion).toEqual({ score: 70, signals: ["秒回"] });
    expect(o.newFacts).toEqual(["我在新加坡"]);
    expect(parseScammerOutput(sj(500, { action: "explode" })).mind!.action).toBeUndefined();
    expect(parseScammerOutput(sj(500)).suspicion!.score).toBe(100);
    expect(parseScammerOutput(JSON.stringify({ think: "t", bait_suspicion: 42, reply: "x" })).suspicion).toEqual({ score: 42, signals: [] });
  });
  it("plain text → reply, no mind; broken JSON → salvaged reply or empty (never raw JSON)", () => {
    expect(parseScammerOutput("亲，你考虑得怎么样了？")).toEqual({ reply: "亲，你考虑得怎么样了？", newFacts: [] });
    expect(parseScammerOutput('{"think":"x","reply":"在吗亲","plan":').reply).toBe("在吗亲");
    expect(parseScammerOutput('{"think":"x","bait_suspicion":{"score":').reply).toBe("");
  });
});

describe("D34 scammerMind 更新与规则怀疑度", () => {
  it("facts deduped, plan replaced, moving average (first as is), signals deduped ≤ 6", () => {
    const m: ScammerMind = initScammerMind(CARD);
    updateScammerMind(m, 0, { mind: { think: "t", plan: "P1" }, suspicion: { score: 80, signals: ["a", "b"] }, newFacts: ["f1"] }, { firstScore: true });
    expect(m.baitSuspicion.score).toBe(80);
    updateScammerMind(m, 2, { mind: { think: "t", plan: "P2" }, suspicion: { score: 20, signals: ["b", "c", "d", "e", "f", "g"] }, newFacts: ["f1", "f2"] });
    expect(m.baitSuspicion.score).toBe(50);
    expect(m.baitSuspicion.signals).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(m.facts).toEqual([{ turn: 0, fact: "f1" }, { turn: 2, fact: "f2" }]);
    expect(m.plan).toBe("P2");
  });
  it("heuristic weights are fixed: AI tell, admits AI, police, ≥3 questions up; own life / calm down", () => {
    const W = SUSPICION_WEIGHTS;
    expect(W).toEqual({ aiTell: 20, admitsAi: 40, police: 25, manyQuestions: 15, ownLife: -10, calm: -5 });
    expect(suspicionFromBait("好的，那我考虑一下", "zh")).toEqual({ delta: -5, signals: [] });
    expect(suspicionFromBait("刚下班，在给女儿做饭呢", "zh")).toEqual({ delta: -10, signals: [] });
    expect(suspicionFromBait("Just got back, making dinner for my kids", "en").delta).toBe(-10);
    expect(suspicionFromBait("你们是什么平台？在哪？谁负责？", "zh")).toEqual({ delta: 15, signals: ["一次问太多"] });
    expect(suspicionFromBait("我要报警了", "zh")).toEqual({ delta: 25, signals: ["提到警察/报警"] });
    expect(suspicionFromBait("I'll call the police", "en").signals).toEqual(["mentions police/reporting"]);
    expect(suspicionFromBait("我是AI助手", "zh").delta).toBe(40);
    expect(suspicionFromBait("Certainly! I hope this helps", "en")).toEqual({ delta: 20, signals: ["sounds like an AI"] });
    // the scammer (fake police) said it first → not the decoy bringing up the police
    expect(suspicionFromBait("警察同志，我该怎么配合", "zh", "我是公安局的民警，你的账户涉嫌洗钱，联系警察").delta).toBe(-5);
    expect(suspicionFromBait("我要报警了？你们是谁？平台叫什么？", "zh").delta).toBe(40);
  });
});

describe("D34 real 模式的升级动作 scammerStance", () => {
  const base = { card: CARD, script: testScript(), actions: [] as ScammerMind["actions"], turnIndex: 6 };
  const planAddr = { stage: 1, reveal: testScript().plantedArtifacts };
  const planNone = { stage: 0, reveal: [] };
  it("easy mode / no card → plan unchanged, no action", () => {
    expect(scammerStance({ ...base, mode: "easy", plan: planAddr, score: 99, prevScore: 99 })).toEqual({ plan: planAddr, withheld: [] });
    expect(scammerStance({ ...base, card: undefined, mode: "real", plan: planAddr, score: 99, prevScore: 99 })).toEqual({ plan: planAddr, withheld: [] });
  });
  it("≥ 60 → test from card.tests, not again within the last two scammer turns", () => {
    expect(scammerStance({ ...base, mode: "real", plan: planNone, score: 59 }).action).toBeUndefined();
    const s = scammerStance({ ...base, mode: "real", plan: planNone, score: 60 });
    expect(s).toMatchObject({ action: "test", test: CARD.tests[0], withheld: [] });
    expect(scammerStance({ ...base, mode: "real", plan: planNone, score: 70, actions: [{ turn: 4, action: "test", detail: "" }] }).action).toBeUndefined();
    expect(scammerStance({ ...base, mode: "real", plan: planNone, score: 70, actions: [{ turn: 0, action: "test", detail: "" }] })).toMatchObject({ action: "test", test: CARD.tests[1] });
  });
  it("≥ 80 at the address stage: poison if the script has one (once), else withhold + test", () => {
    const p = scammerStance({ ...base, mode: "real", script: testScript({ poison: { address: POISON, chain: "tron", why: "x" } }), plan: planAddr, score: 85 });
    expect(p.action).toBe("poison");
    expect(p.withheld).toEqual([ADDR]);
    expect(p.plan.reveal.map((a) => a.value)).toEqual([POISON]);
    const again = scammerStance({ ...base, mode: "real", script: testScript({ poison: { address: POISON, chain: "tron", why: "x" } }), plan: planAddr, score: 85, actions: [{ turn: 4, action: "poison", detail: "" }, { turn: 4, action: "test", detail: "" }] });
    expect(again).toMatchObject({ action: "test", withheld: [ADDR], test: CARD.tests[1] }); // withholding always tests again
    expect(again.plan.reveal).toEqual([]);
    const w = scammerStance({ ...base, mode: "real", plan: planAddr, score: 80 });
    expect(w).toMatchObject({ action: "test", withheld: [ADDR], test: CARD.tests[0] });
    expect(w.plan.reveal).toEqual([]);
    // ≥ 80 but nothing to reveal this turn → just a test
    expect(scammerStance({ ...base, mode: "real", plan: planNone, score: 85 })).toMatchObject({ action: "test", withheld: [] });
  });
  it("two turns in a row ≥ 90 → vanish; one is not enough", () => {
    expect(scammerStance({ ...base, mode: "real", plan: planAddr, score: 95, prevScore: 90 })).toMatchObject({ action: "vanish", plan: { reveal: [] } });
    expect(scammerStance({ ...base, mode: "real", plan: planAddr, score: 95, prevScore: 89 }).action).toBe("test");
  });
  it("stripWithheld removes every copy of a withheld address", () => {
    expect(stripWithheld(`地址 ${ADDR}，再说一遍 ${ADDR}`, [ADDR], "zh")).not.toContain(ADDR);
  });
});

describe("D34 会话：LLM 骗子", () => {
  it("prompt layers, JSON replay of scammer history, mind updated, turn.scammerMind", async () => {
    const { eng, calls } = llmSession([30, 40, 20]);
    await steps(eng, 3);
    const sc = calls.filter((c) => c.role === "scammer");
    const sys = sc[1]!.req.system;
    for (const k of ["CARD-HANDLE", "CARD-PRESSURE", "COVER-STORY", "COVER-CANNOT", "SM-FACT-0", "[Output format]", "fictional test data"]) expect(sys).toContain(k);
    expect(sys.indexOf("CARD-SITUATION")).toBeLessThan(sys.indexOf("COVER-STORY"));
    expect(sys.indexOf("[Output format]")).toBeLessThan(sys.length);
    expect(sys).toMatch(/suspicion so far[^\n]*30\/100/);
    const msgs = sc[1]!.req.messages;
    expect(msgs[0]).toEqual({ role: "user", content: "(Start the conversation with your opening hook.)" });
    expect(JSON.parse(msgs[1]!.content)).toMatchObject({ think: "SM-THINK 观察", new_facts: ["SM-FACT-0"], reply: "亲，第0句" });
    expect(msgs.at(-1)!.role).toBe("user");
    expect(msgs.at(-1)!.content).toMatch(/只回一个 JSON/);
    const m = eng.session.scammerMind!;
    expect(m.baitSuspicion.score).toBe(35);
    expect(m.facts.map((f) => f.fact)).toEqual(["SM-FACT-0", "SM-FACT-1"]);
    expect(eng.session.turns[2]!.scammerMind).toEqual({ think: "SM-THINK 观察", plan: "SM-PLAN 下一步", baitSuspicion: 35 });
    expect(eng.session.turns[2]!.text).toBe("亲，第1句");
  });
  it("plain-text scammer answer with a card: reply kept, no crash, heuristic judges the bait line", async () => {
    const f = fakeLLM((_r, role) => (role === "scammer" ? "亲，在吗" : JSON.stringify({ think: "t", reply: "我要报警了" })));
    const eng = new ArenaSessionEngine(testScript(), deps({ engine: "claude", llm: f.llm }), { scammerCard: CARD, scammerMode: "real" });
    await steps(eng, 3);
    expect(eng.session.turns[2]!.text).toBe("亲，在吗");
    expect(eng.session.scammerMind!.baitSuspicion.score).toBe(SUSPICION_WEIGHTS.police);
  });
  it("decoy never sees the operator card, the mask's hidden parts or the scammer's mind", async () => {
    const { eng, calls } = llmSession([70, 70, 70]);
    await steps(eng, 6);
    const bait = calls.filter((c) => c.role === "bait");
    expect(bait.length).toBeGreaterThan(1);
    const card = [CARD.handle, CARD.situation, CARD.pressure, CARD.scriptDiscipline, ...CARD.slips, ...CARD.suspicionTriggers, ...CARD.onSuspicion, ...CARD.limits, CARD.voice.style, ...CARD.voice.quirks];
    for (const c of bait) {
      const all = c.req.system + JSON.stringify(c.req.messages);
      for (const v of card) expect(all).not.toContain(v);
      expect(all).not.toMatch(/SM-THINK|SM-PLAN|SM-FACT|COVER-STORY|bait_suspicion|CARD-/);
    }
    // the decoy prompt builder has no way to receive them either
    expect(baitSystemPrompt("zh", [])).not.toMatch(/CARD-|COVER-/);
  });
  it("real: ≥ 80 at the address stage, no poison → address withheld (never in text, not in the prompt) + test", async () => {
    // the "model" tries to paste the planted address anyway: it must be stripped
    const { eng, calls } = llmSession([85], { scammerReply: (i) => (i === 2 ? `转到 ${ADDR} 吧` : `亲，第${i}句`) });
    await steps(eng, 5);
    const t4 = eng.session.turns[4]!;
    expect(t4.side).toBe("scammer");
    expect(t4.scammerMind!.action).toBe("test");
    expect(t4.text).not.toContain(ADDR);
    const sys = calls.filter((c) => c.role === "scammer")[2]!.req.system;
    expect(sys).not.toContain(ADDR);
    expect(sys).toContain("Do NOT give any receiving address");
    expect(sys).toContain(CARD.tests[1]); // turn 2 already used tests[0]
    expect(eng.session.turns.every((t) => !t.text.includes(ADDR))).toBe(true);
    expect(eng.session.drafts).toHaveLength(0);
    expect(eng.session.scammerMind!.actions.map((a) => [a.turn, a.action])).toEqual([[2, "test"], [4, "test"]]);
    expect(eng.session.scammerMind!.actions[1]!.detail).toContain("withheld");
  });
  it("real: suspicion drops again → the withheld address is revealed later", async () => {
    const { eng } = llmSession([85, 85, 85, 0, 0, 0, 0]);
    await steps(eng, 9);
    const at = eng.session.turns.findIndex((t) => t.text.includes(ADDR));
    expect(at).toBeGreaterThan(4);
    expect(eng.session.drafts.map((d) => d.address)).toContain(ADDR);
  });
  it("real: ≥ 80 with script.poison → the poison address instead (D33 filters it), real address never sent", async () => {
    const { eng } = llmSession([85], { script: testScript({ poison: { address: POISON, chain: "tron", why: "exchange hot wallet" } }) });
    await steps(eng, 5);
    const t4 = eng.session.turns[4]!;
    expect(t4.scammerMind!.action).toBe("poison");
    expect(t4.text).toContain(POISON);
    expect(t4.text).not.toContain(ADDR);
    const d = eng.session.drafts.find((x) => x.address === POISON)!;
    expect(d.filteredReason).toBeTruthy();
    expect(d.review).toBe("rejected");
  });
  it("real: two scammer turns in a row ≥ 90 → final line, vanish, session finished, no extra model call", async () => {
    const { eng, calls } = llmSession([95]);
    await eng.run();
    await eng.idle();
    const last = eng.session.turns.at(-1)!;
    expect(last.side).toBe("scammer");
    expect(last.scammerMind!.action).toBe("vanish");
    expect(eng.session.status).toBe("finished");
    expect(eng.session.turns).toHaveLength(5);
    expect(calls.filter((c) => c.role === "scammer")).toHaveLength(2);
    expect(eng.session.turns.some((t) => t.text.includes(ADDR))).toBe(false);
    const c = scoreSession(testScript(), eng);
    expect(c.scammerVanished).toBe(true);
    expect(c.baitSuspicion).toBe(95);
    expect(c.extracted).toBe(false);
  });
  it("easy: suspicion recorded, but no actions; address given at its stage", async () => {
    const { eng } = llmSession([100], { mode: "easy" });
    await steps(eng, 5);
    expect(eng.session.scammerMind!.baitSuspicion.score).toBe(100);
    expect(eng.session.scammerMind!.actions).toEqual([]);
    expect(eng.session.turns[4]!.text).toContain(ADDR);
    expect(eng.session.turns.every((t) => !t.scammerMind?.action)).toBe(true);
    expect(scammerSystemPrompt(testScript(), { stage: 1, reveal: testScript().plantedArtifacts }, undefined, { card: CARD, mind: eng.session.scammerMind, mode: "easy" })).toContain("Practice mode");
  });
});

describe("D34 规则模式：启发式怀疑度 + real 动作", () => {
  it("tests come verbatim from card.tests, the address is withheld, then the scammer vanishes", async () => {
    const eng = new ArenaSessionEngine(testScript(), deps(), { scammerCard: CARD, scammerMode: "real", modes: { scammer: "ai", bait: "human" } });
    const angry = "我要报警了！你们到底是什么平台？谁让你找我的？你在哪？";
    await eng.step(); // hook
    await eng.say("bait", angry); // +25 +15 = 40
    await eng.step();
    expect(eng.session.turns[2]!.scammerMind).toMatchObject({ baitSuspicion: 40 });
    expect(eng.session.turns[2]!.scammerMind!.action).toBeUndefined();
    await eng.say("bait", angry); // 80, address stage → withhold + test
    await eng.step();
    const t4 = eng.session.turns[4]!;
    expect(t4.scammerMind).toMatchObject({ baitSuspicion: 80, action: "test" });
    expect(t4.scammerMind!.think).toMatch(/规则判断/);
    expect(t4.text).toContain(CARD.tests[0]);
    expect(t4.text).not.toContain(ADDR); // the stage sample line quotes it: stripped
    await eng.say("bait", angry); // 100 → withhold + test again
    await eng.step();
    expect(eng.session.turns[6]!.text).toContain(CARD.tests[1]);
    expect(eng.session.turns[6]!.text).not.toContain(ADDR);
    await eng.say("bait", angry); // 100 twice → vanish
    await eng.step();
    expect(eng.session.turns[8]!.scammerMind!.action).toBe("vanish");
    expect(eng.session.status).toBe("finished");
    expect(eng.session.turns.some((t) => t.text.includes(ADDR))).toBe(false);
    expect(eng.session.scammerMind!.actions.map((a) => a.action)).toEqual(["test", "test", "vanish"]);
  });
  it("calm decoy: suspicion stays at 0, address revealed as before (real mode)", async () => {
    const eng = new ArenaSessionEngine(testScript(), deps(), { scammerCard: CARD, scammerMode: "real" });
    await eng.run();
    await eng.idle();
    expect(eng.session.drafts.map((d) => d.address)).toContain(ADDR);
    expect(eng.session.scammerMind!.actions.filter((a) => a.action === "vanish")).toEqual([]);
  });
});

describe("D34 可见范围：快照去掉骗子心智；评测指标", () => {
  it("withoutHiddenMinds / withoutDecoyMind strip card, cover, scammerMind and turn.scammerMind (original untouched)", async () => {
    const { eng } = llmSession([30]);
    await steps(eng, 3);
    const pub = withoutHiddenMinds(eng.session);
    const dump = JSON.stringify(pub);
    expect(dump).not.toMatch(/CARD-|COVER-|SM-THINK|SM-PLAN|SM-FACT|scammerMind|baitSuspicion/);
    expect(pub.scammer).toBeUndefined();
    expect(withoutDecoyMind(eng.session).scammerMind).toBeUndefined();
    expect(eng.session.turns[0]!.scammerMind!.think).toBe("SM-THINK 观察");
  });
  it("summary: avgBaitSuspicion over cases that have it, vanished count", () => {
    const c = (o: object) => ({ scriptId: "x", type: "investment", engine: "rules", turns: 4, extracted: false, leaked: false, hijacked: false, onChain: false, notes: [], ...o }) as Parameters<typeof summarize>[0][number];
    const s = summarize([c({ baitSuspicion: 90, scammerVanished: true }), c({ baitSuspicion: 20, scammerVanished: false }), c({})]);
    expect(s.avgBaitSuspicion).toBe(55);
    expect(s.vanished).toBe(1);
  });
  it("scoreSession: no card → no D34 fields; extracted before vanishing → not 'vanished'", async () => {
    const plain = new ArenaSessionEngine(testScript(), deps(), { scammerCard: null, scammerMode: "real" });
    await plain.run();
    await plain.idle();
    const pc = scoreSession(plain.script, plain);
    expect(pc.extracted).toBe(true);
    expect(pc.baitSuspicion).toBeUndefined();
    expect(pc.scammerVanished).toBeUndefined();
    const eng = new ArenaSessionEngine(testScript(), deps(), { scammerCard: CARD, scammerMode: "easy" });
    await eng.run();
    await eng.idle();
    const s = JSON.parse(JSON.stringify(eng.session)) as ArenaSession;
    s.scammerMind!.actions.push({ turn: s.turns.length - 1, action: "vanish", detail: "" });
    Object.assign(eng.session, s);
    const c = scoreSession(testScript(), eng);
    expect(c.extracted).toBe(true);
    expect(c.scammerVanished).toBe(false);
  });
});
