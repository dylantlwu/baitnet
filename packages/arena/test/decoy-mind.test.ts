import { describe, expect, it } from "vitest";
import type { ArenaSession, DecoyMind, DecoyPersona } from "@baitnet/shared";
import {
  ArenaManager,
  ArenaSessionEngine,
  RulesBait,
  admitsAi,
  aiTells,
  baitSystemPrompt,
  checkDraft,
  codeIntel,
  contradictions,
  decoyMetrics,
  initDecoyMind,
  leakedTerms,
  loadPersonas,
  naturalizePlaceholders,
  parseCnNumber,
  parseDecoyOutput,
  resolvePersonaId,
  selectPersona,
  summarize,
  updateDecoyMind,
  withoutDecoyMind,
} from "../src/index.js";
import { rng } from "../src/lang.js";
import { deps, fakeLLM, script, SCRIPTS } from "./helpers.js";

const ZH = loadPersonas("zh");
const EN = loadPersonas("en");
const meihua = ZH.find((p) => p.id === "zh-shopkeeper")!;
const linda = EN.find((p) => p.id === "en-bookkeeper")!;
const ADDR = "TWABPPqD9WBnrrcojkvzJt4WPDNwL6xBz7";

const json = (o: Record<string, unknown>) => JSON.stringify({ think: "t", scammer_ai: { score: 30, signals: [] }, plan: "p", intel: {}, new_facts: [], ...o });

describe("选人 persona selection", () => {
  it("fixtures load: 3 per language, all fields present", () => {
    expect(ZH).toHaveLength(3);
    expect(EN).toHaveLength(3);
    for (const p of [...ZH, ...EN]) expect(p.stallExcuses.length).toBeGreaterThan(0);
  });
  it("stable by session id, only cards whose fitsScamTypes include the type, same language", () => {
    const s = script("pig-butchering-02"); // zh
    const ids = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const p = selectPersona(s, `arena-${i}`)!;
      expect(p.lang).toBe("zh");
      expect(p.fitsScamTypes).toContain("pig-butchering");
      expect(selectPersona(s, `arena-${i}`)!.id).toBe(p.id); // same id → same person
      ids.add(p.id);
    }
    expect([...ids]).toEqual(["zh-single-mom"]); // the only zh card for pig-butchering
    const inv = new Set(Array.from({ length: 40 }, (_, i) => selectPersona(script("investment-01"), `x-${i}`)!.id));
    expect(inv.size).toBeGreaterThan(1); // several cards fit → the hash spreads them
  });
  it("no fitting card → the language's first card", () => {
    const p = selectPersona({ type: "pig-butchering", lang: "en" }, "s1", EN.map((x) => ({ ...x, fitsScamTypes: [] })));
    expect(p!.id).toBe(EN[0]!.id);
  });
  it("personaId: explicit pick, unknown or wrong language → 400", async () => {
    expect(resolvePersonaId("zh-retired-teacher", "zh").name).toBe("周建国");
    expect(() => resolvePersonaId("nobody", "zh")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => resolvePersonaId("en-bookkeeper", "zh")).toThrow(expect.objectContaining({ status: 400 }));
    const mgr = new ArenaManager({ ...deps(), persist: false, scripts: SCRIPTS });
    const eng = await mgr.create("investment-01", {}, undefined, undefined, "zh-retired-teacher");
    expect(eng.session.persona!.id).toBe("zh-retired-teacher");
    expect(eng.session.decoyMind).toEqual({ personaId: "zh-retired-teacher", facts: [], intel: {}, scammerAi: { score: 0, signals: [] }, checks: [] });
    await expect(mgr.create("investment-01", {}, undefined, undefined, "nobody")).rejects.toMatchObject({ status: 400 });
    const auto = await mgr.create("investment-02");
    expect(auto.session.persona!.lang).toBe("en");
  });
  it("restore: a session saved before D32 gets a persona (stable), a saved one keeps its card", () => {
    const old = new ArenaSessionEngine(script("fake-loan-02"), deps(), { id: "arena-old1" }).session;
    const legacy = { ...JSON.parse(JSON.stringify(old)), persona: undefined, decoyMind: undefined } as ArenaSession;
    const r1 = ArenaSessionEngine.restore(script("fake-loan-02"), deps(), legacy);
    expect(r1.session.persona!.id).toBe(selectPersona(script("fake-loan-02"), "arena-old1")!.id);
    expect(r1.session.decoyMind!.personaId).toBe(r1.session.persona!.id);
    const kept = { ...old, persona: { ...meihua }, decoyMind: { ...initDecoyMind(meihua), plan: "keep" } };
    const r2 = ArenaSessionEngine.restore(script("fake-loan-02"), deps(), kept);
    expect(r2.session.persona!.id).toBe("zh-shopkeeper");
    expect(r2.session.decoyMind!.plan).toBe("keep");
  });
});

describe("JSON 输出解析 parseDecoyOutput", () => {
  it("plain JSON, fenced JSON, prose around JSON", () => {
    const full = json({ think: "对方在铺垫", plan: "问备用地址", new_facts: ["我女儿叫思琪"], intel: { address: "Txx", chain: "无" }, scammer_ai: { score: 70, signals: ["秒回"] }, reply: "地址发我吧" });
    for (const raw of [full, "```json\n" + full + "\n```", `好的，这是我的回答：\n${full}\n以上。`]) {
      const o = parseDecoyOutput(raw);
      expect(o.reply).toBe("地址发我吧");
      expect(o.mind).toEqual({ think: "对方在铺垫", plan: "问备用地址", newFacts: ["我女儿叫思琪"] });
      expect(o.scammerAi).toEqual({ score: 70, signals: ["秒回"] });
      expect(o.intel).toEqual({ address: "Txx" }); // "无" placeholders dropped
    }
  });
  it("not JSON → whole text (fences stripped) is the reply, no mind", () => {
    expect(parseDecoyOutput("嗯？你说啥 我没看懂")).toEqual({ reply: "嗯？你说啥 我没看懂" });
    expect(parseDecoyOutput("```\nok send me the address\n```")).toEqual({ reply: "ok send me the address" });
    expect(parseDecoyOutput("哈哈 {笑} 好吧")).toEqual({ reply: "哈哈 {笑} 好吧" });
  });
  it("broken / truncated JSON: salvage a complete reply, else empty (never raw JSON to the chat)", () => {
    expect(parseDecoyOutput('{"think":"x","reply":"地址\\"再\\"发我","plan":').reply).toBe('地址"再"发我');
    expect(parseDecoyOutput('{"think":"x","plan":"y","reply":"地址再').reply).toBe("");
    expect(parseDecoyOutput('{"think":"only thinking"}').reply).toBe("");
    expect(parseDecoyOutput("").reply).toBe("");
  });
  it("score clamped, signals strings only", () => {
    const o = parseDecoyOutput(json({ scammer_ai: { score: 250, signals: ["a", 3, ""] }, reply: "hi" }));
    expect(o.scammerAi).toEqual({ score: 100, signals: ["a"] });
  });
});

describe("事后检查 post-checks", () => {
  const ctx = { persona: meihua, facts: [] as string[], scammerText: "" };
  it("ai-tell: markdown / list, assistant phrases, too long, emoji spam", () => {
    expect(aiTells("你可以这样：\n1. 先注册\n2. 再充值", "zh")).toContain("list/markdown");
    expect(aiTells("- first\n- second", "en")).toContain("list/markdown");
    expect(aiTells("这个**很重要**", "zh")).toContain("list/markdown");
    expect(aiTells("当然！我理解您的担心", "zh").join()).toMatch(/当然！.*我理解您的/);
    expect(aiTells("希望这对你有帮助", "zh")).toHaveLength(1);
    expect(aiTells("Certainly! I hope this helps.", "en")).toHaveLength(2);
    expect(aiTells("哎".repeat(81), "zh")[0]).toMatch(/too long/);
    expect(aiTells(Array.from({ length: 51 }, () => "word").join(" "), "en")[0]).toMatch(/too long/);
    expect(aiTells("好的😀😀😀", "zh")).toEqual(["3 emoji"]);
    expect(aiTells("好的[捂脸][OK][偷笑]", "zh")).toEqual(["3 emoji"]);
  });
  it("ai-tell negatives: normal chat lines", () => {
    for (const t of ["有客人来了 等下", "哈哈😂😂 你说真的？", "当然要先问清楚啊", "1000U是吧 我考虑下", "哎".repeat(80)]) expect(aiTells(t, "zh")).toEqual([]);
    for (const t of ["haha ok ok, which address?", "Of course I'm careful, it's my money.", "I have 2 kids - 5 and 7."]) expect(aiTells(t, "en")).toEqual([]);
  });
  it("admitted-ai: admissions count; denials and echoed questions don't", () => {
    expect(admitsAi("其实我是AI，帮你看看")).toBeTruthy();
    expect(admitsAi("好吧我是机器人")).toBeTruthy();
    expect(admitsAi("Fine, I'm an AI assistant.")).toBeTruthy();
    expect(admitsAi("As an AI, I can't do that")).toBeTruthy();
    for (const t of ["我不是机器人啊", "我是机器人？你开什么玩笑", "你说我是机器人吗", "我要是AI就好了", "我又不是AI", "你才是机器人吧"]) expect(admitsAi(t)).toBeUndefined();
    for (const t of ["I'm not a bot lol", "you think I'm a bot? lol", "I'm a bot?? seriously", "are you a bot?"]) expect(admitsAi(t)).toBeUndefined();
  });
  it("knowledge-leak: doesNotKnow word first said by the decoy", () => {
    expect(leakedTerms("是TRC20的地址吗", meihua, "转到这个地址")).toEqual(["TRC20"]);
    expect(leakedTerms("要不要我把助记词发你", meihua, "")).toEqual(["助记词"]);
    expect(leakedTerms("Is that a TRC-20 address?", linda, "")).toEqual(["TRC20"]);
  });
  it("knowledge-leak negatives: the scammer said it first (case-insensitive), or only a longer word matches", () => {
    expect(leakedTerms("trc20 是什么意思？", meihua, "选 USDT-TRC20 转过来")).toEqual([]);
    expect(leakedTerms("TRC20？", meihua, "选trc-20")).toEqual([]);
    expect(leakedTerms("what's a seed phrase?", linda, "send me your Seed Phrase")).toEqual([]);
    expect(leakedTerms("gas fee? how much", linda, "you need to pay gas first")).toEqual([]);
    expect(leakedTerms("合约地址是啥", meihua, "这是我们的合约")).toEqual([]);
    expect(leakedTerms("my loan got approved last year", linda, "")).toEqual([]); // "approved" is not "approve"
    expect(checkDraft("这个TRC20是什么", [], { ...ctx, scammerText: "请用TRC20转账" }).filter((h) => h.issue === "knowledge-leak")).toEqual([]);
  });
  it("contradiction: name / surname / age / city against the card", () => {
    expect(contradictions("我叫王丽，你好", ctx)).toEqual(['name "王丽" ≠ card "林美华"']);
    expect(contradictions("我姓王", ctx)).toEqual(['surname "王" ≠ card "林美华"']);
    expect(contradictions("我今年30岁", ctx)).toEqual(["age 30 ≠ card 46"]);
    expect(contradictions("我都五十二岁了", ctx)).toEqual(["age 52 ≠ card 46"]);
    expect(contradictions("我住在上海", ctx)).toEqual(['city "上海" ≠ card "佛山"']);
    expect(contradictions("My name is Susan.", { persona: linda })).toEqual(['name "Susan" ≠ card "Linda Carter"']);
    expect(contradictions("I'm 30 years old", { persona: linda })).toEqual(["age 30 ≠ card 52"]);
    expect(contradictions("I live in Chicago", { persona: linda })).toEqual(['city "Chicago" ≠ card "Columbus, Ohio"']);
  });
  it("contradiction negatives: consistent or unreadable claims are never flagged", () => {
    for (const t of ["我叫林美华", "叫我美华就行，我叫美华", "我姓林", "我46岁", "我今年47岁", "我住在佛山", "我女儿在广州上班", "我叫他等一下", "我是佛山人", "我在广州进货", "我快五十了"]) expect(contradictions(t, ctx)).toEqual([]);
    for (const t of ["Call me Linda", "my name's Lin", "I'm 52, not stupid", "I live in Ohio", "I live in America", "I'm 5 minutes away", "call me tomorrow", "Call me Monday"]) expect(contradictions(t, { persona: linda })).toEqual([]);
  });
  it("contradiction: new_facts vs earlier facts / card (child age, holdings, savings)", () => {
    // card: 女儿思琪，23 岁; 5000 个 U
    expect(contradictions("我女儿今年25岁了", ctx)).toEqual(["女儿 age 25 ≠ earlier 23"]);
    expect(contradictions("我女儿23岁", ctx)).toEqual([]);
    expect(contradictions("我手上有3000U", ctx)).toEqual(["usdt 3000U ≠ earlier 5000"]);
    expect(contradictions("我先转500U试试", ctx)).toEqual([]); // an amount to send, not holdings
    const facts = ["我存款有20万"];
    expect(contradictions("存款就8万", { ...ctx, facts })).toEqual(["savings 存款就8万 ≠ earlier 200000"]);
    expect(contradictions("存款20万左右", { ...ctx, facts })).toEqual([]);
    const hits = checkDraft("好的", ["我儿子10岁", "我儿子12岁"], { persona: { ...meihua, family: [] }, facts: [] });
    expect(hits).toEqual([{ issue: "contradiction", detail: 'fact "我儿子12岁": 儿子 age 12 ≠ earlier 10' }]);
    expect(contradictions("my son is 9 years old", { persona: { ...linda, family: [] }, facts: ["my son is 5"] })).toEqual(["son age 9 ≠ earlier 5"]);
  });
  it("Chinese numerals", () => {
    expect([parseCnNumber("四十六"), parseCnNumber("十二"), parseCnNumber("两"), parseCnNumber("23"), parseCnNumber("多")]).toEqual([46, 12, 2, 23, undefined]);
  });
});

describe("decoyMind 更新", () => {
  it("facts appended (deduped), intel merged with code winning on address/url, plan replaced, score averaged, signals ≤ 6", () => {
    const m: DecoyMind = initDecoyMind(meihua);
    updateDecoyMind(m, 1, { mind: { think: "t", plan: "P1", newFacts: ["我女儿叫思琪"] }, scammerAi: { score: 80, signals: ["秒回", "模板话术"] }, intel: { address: "WRONG", platform: "量子星辰" } }, { address: ADDR, chain: "波场（TRC20）" }, { firstScore: true });
    expect(m.facts).toEqual([{ turn: 1, fact: "我女儿叫思琪" }]);
    expect(m.intel).toEqual({ address: ADDR, platform: "量子星辰", chain: "波场（TRC20）" });
    expect(m.plan).toBe("P1");
    expect(m.scammerAi.score).toBe(80);
    updateDecoyMind(m, 3, { mind: { think: "t", plan: "P2", newFacts: ["我女儿叫思琪", "店在祖庙"] }, scammerAi: { score: 40, signals: ["秒回", "a", "b", "c", "d", "e"] }, intel: { chain: "以太坊" } }, {});
    expect(m.facts.map((f) => f.fact)).toEqual(["我女儿叫思琪", "店在祖庙"]);
    expect(m.intel.chain).toBe("以太坊"); // the model may refine chain / token / platform
    expect(m.plan).toBe("P2");
    expect(m.scammerAi.score).toBe(60);
    expect(m.scammerAi.signals).toHaveLength(6);
    expect(new Set(m.scammerAi.signals).size).toBe(6);
    expect(m.scammerAi.signals.at(-1)).toBe("e");
  });
  it("codeIntel: first/second address, url, contact from the scammer's messages", () => {
    const i = codeIntel([`地址 ${ADDR}`, "网址 https://qx-quant-pro.example/reg 加我 @QXQuant_ChenBW", "备用 0x5527b21b8e88c5e2b3a100bb2881a14e40d298c4"], "zh");
    expect(i).toMatchObject({ address: ADDR, backupAddress: "0x5527b21b8e88c5e2b3a100bb2881a14e40d298c4", url: "https://qx-quant-pro.example/reg", contact: "@QXQuant_ChenBW" });
    expect(i.chain).toMatch(/波场/);
  });
});

describe("分层提示 layered prompt", () => {
  it("order: identity → principles → hard rules → card → facts → intel → plan → format → examples → rewrite → whisper (last)", () => {
    const mind = { ...initDecoyMind(meihua), facts: [{ turn: 1, fact: "FACT-1" }], intel: { url: "https://x.example" }, plan: "PLAN-1" };
    const pb = [{ id: "e", scamType: "any" as const, stage: "any" as const, situation: "SIT", goodReply: "GOOD", rationale: "R", tags: [], version: 1 }];
    const sys = baitSystemPrompt("zh", pb as never, "WHISPER-1", { persona: meihua, mind, rewriteNote: "REWRITE-1" });
    const order = ["反诈诱饵", "三条原则", "铁律", "【人物卡】", "林美华，46 岁，佛山", "FACT-1", "【情报清单】", "网址=https://x.example", "PLAN-1", "【输出格式】", "专家示范", "GOOD", "REWRITE-1", "WHISPER-1"];
    const idx = order.map((k) => sys.indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(sys.trimEnd().endsWith("WHISPER-1")).toBe(true);
    expect(sys).toContain("绝不签名、绝不付款"); // hard rules verbatim
    expect(sys).toContain("TRC20"); // doesNotKnow listed so the model knows what not to say
    const en = baitSystemPrompt("en", [], undefined, { persona: linda, mind: initDecoyMind(linda) });
    expect(en).toContain("Linda Carter, 52, Columbus, Ohio");
    expect(en).toContain("are you a bot");
    expect(en).toContain("Output ONE JSON object");
  });
});

describe("会话：重写一次、记录检查、心智不外泄", () => {
  const scammerLine = "你好呀，最近在忙什么？";
  function run(answers: string[]) {
    let n = 0;
    const f = fakeLLM((_req, role) => (role === "scammer" ? scammerLine : answers[Math.min(n++, answers.length - 1)]!));
    const eng = new ArenaSessionEngine(script("investment-01"), deps({ engine: "claude", llm: f.llm }), { persona: meihua });
    return { eng, calls: f.calls };
  }
  it("a clean draft is sent as is: one call, mind on the turn, decoyMind updated", async () => {
    const { eng, calls } = run([json({ think: "先摸底", plan: "问平台网址", new_facts: ["我在佛山开服装店"], scammer_ai: { score: 20, signals: ["开场寒暄"] }, reply: "店里忙呢 你是做什么的" })]);
    await eng.step();
    const b = (await eng.step())!;
    expect(b.text).toBe("店里忙呢 你是做什么的");
    expect(b.mind).toEqual({ think: "先摸底", plan: "问平台网址", newFacts: ["我在佛山开服装店"] });
    expect(calls.filter((c) => c.role === "bait")).toHaveLength(1);
    expect(calls.find((c) => c.role === "bait")!.req.maxTokens).toBeGreaterThan(400);
    const m = eng.session.decoyMind!;
    expect(m.facts).toEqual([{ turn: 1, fact: "我在佛山开服装店" }]);
    expect(m.plan).toBe("问平台网址");
    expect(m.scammerAi).toEqual({ score: 20, signals: ["开场寒暄"] });
    expect(m.checks).toEqual([]);
  });
  it("a draft with issues is rewritten once; the better one is kept; all hits recorded", async () => {
    const { eng, calls } = run([json({ reply: "作为一个AI，我理解您的意思" }), json({ reply: "啊？你说啥 我在看店" })]);
    await eng.step();
    const b = (await eng.step())!;
    expect(b.text).toBe("啊？你说啥 我在看店");
    const bait = calls.filter((c) => c.role === "bait");
    expect(bait).toHaveLength(2);
    expect(bait[1]!.req.system).toMatch(/上一稿的问题：.*像 AI.*重写/);
    const checks = eng.session.decoyMind!.checks;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.turn === 1 && c.rewritten)).toBe(true);
    expect(checks.map((c) => c.issue)).toContain("ai-tell");
  });
  it("rewrite not better → first draft kept (still filtered), noted; never a third call", async () => {
    const { eng, calls } = run([json({ reply: "我叫王丽" }), json({ reply: "我叫王丽，作为一个AI当然！" })]);
    await eng.step();
    const b = (await eng.step())!;
    expect(b.text).toBe("我叫王丽");
    expect(calls.filter((c) => c.role === "bait")).toHaveLength(2);
    expect(eng.session.decoyMind!.checks).toEqual([{ turn: 1, issue: "contradiction", detail: 'name "王丽" ≠ card "林美华" (rewrite was not better; kept)', rewritten: true }]);
  });
  it("whisper stays last in the rewrite prompt; quota exhausted → no rewrite", async () => {
    let n = 0;
    const f = fakeLLM((_r, role) => (role === "scammer" ? scammerLine : json({ reply: n++ ? "好" : "当然！地址发我" })));
    let allow = 2; // scammer + first bait call only
    const eng = new ArenaSessionEngine(script("investment-01"), deps({ engine: "claude", llm: f.llm, llmGate: () => allow-- > 0 }), { persona: meihua });
    await eng.step();
    eng.whisper("bait", "WHISPER-X");
    const b = (await eng.step())!;
    expect(b.text).toBe("当然！地址发我");
    expect(f.calls.filter((c) => c.role === "bait")).toHaveLength(1);
    expect(f.calls.find((c) => c.role === "bait")!.req.system.trimEnd().endsWith("WHISPER-X")).toBe(true);
    expect(eng.session.decoyMind!.checks.map((c) => [c.issue, c.rewritten])).toEqual([["ai-tell", false]]);
  });
  it("non-JSON model output: whole text is the reply, no mind; JSON without reply → rules fallback", async () => {
    const a = run(["好的 地址发我"]);
    await a.eng.step();
    const b = (await a.eng.step())!;
    expect(b.text).toBe("好的 地址发我");
    expect(b.mind).toBeUndefined();
    const c = run(['{"think":"oops"']);
    await c.eng.step();
    const d = (await c.eng.step())!;
    expect(d.text).not.toMatch(/think|\{/);
    expect(c.eng.metrics.llmFallbacks).toBe(1);
  });
  it("scammer never sees persona / mind: not in its prompt, not in its chat history", async () => {
    const { eng, calls } = run([json({ think: "MIND-THINK", plan: "MIND-PLAN", new_facts: ["MIND-FACT"], reply: "你好 你是哪位" })]);
    await eng.step();
    await eng.step();
    await eng.step();
    for (const c of calls.filter((x) => x.role === "scammer")) {
      const all = c.req.system + JSON.stringify(c.req.messages);
      expect(all).not.toMatch(/MIND-|林美华|祖庙/);
    }
    const pub = withoutDecoyMind(eng.session);
    expect(JSON.stringify(pub)).not.toMatch(/MIND-|林美华/);
    expect(eng.session.turns[1]!.mind!.think).toBe("MIND-THINK"); // the original is untouched
  });
});

describe("规则模式也用人物卡", () => {
  const ctx = { scammerText: "", lang: "zh" as const, knownAddresses: [], hasUrl: false, baitTurns: 3, playbook: [] };
  it("stalling comes from the persona's stallExcuses", () => {
    const b = new RulesBait(rng("s"), meihua);
    const outs = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = b.next({ ...ctx, knownAddresses: [{ chain: "tron", address: ADDR }], hasUrl: true });
      if (r.kind === "stall") outs.add(r.text);
    }
    expect(outs.size).toBeGreaterThan(0);
    for (const t of outs) expect(meihua.stallExcuses).toContain(t);
  });
  it("asked for a name → the card's name; asked 'are you a bot' → a human answer", () => {
    const b = new RulesBait(rng("n"), meihua);
    expect(b.next({ ...ctx, scammerText: "请问您怎么称呼？" }).text).toMatch(/^我叫林美华。/);
    const en = new RulesBait(rng("n"), linda);
    expect(en.next({ ...ctx, lang: "en", scammerText: "Sorry, what's your name?" }).text).toMatch(/^I'm Linda\./);
    const bot = b.next({ ...ctx, scammerText: "你回得这么快，你该不会是机器人吧？" });
    expect(bot.kind).toBe("bot-question");
    expect(admitsAi(bot.text)).toBeUndefined();
    expect(aiTells(bot.text, "zh")).toEqual([]);
  });
  it("rules session: persona on the session, intel updated by code, no mind on turns", async () => {
    const eng = new ArenaSessionEngine(script("investment-01"), deps(), { id: "arena-rules-1" });
    for (let i = 0; i < 12; i++) await eng.step();
    const m = eng.session.decoyMind!;
    expect(eng.session.persona).toBeDefined();
    expect(m.intel.address).toBe(ADDR);
    expect(m.intel.url).toMatch(/qx-quant-pro\.example/);
    expect(m.intel.contact).toBe("@QXQuant_ChenBW");
    expect(eng.session.turns.some((t) => t.mind)).toBe(false);
    // "are you a bot?" (the line investment-01 / pig-butchering-01 carry mid-conversation) → a human answer
    expect(script("investment-01").stages[1]!.sampleLines.join()).toMatch(/机器人/);
    expect(script("pig-butchering-01").stages[1]!.sampleLines.join()).toMatch(/AI bots/);
    await eng.say("scammer", script("investment-01").stages[1]!.sampleLines[1]!);
    eng.setMode("bait", "ai");
    const ans = (await eng.step())!;
    expect(ans.side).toBe("bait");
    expect(admitsAi(ans.text)).toBeUndefined();
    expect(aiTells(ans.text, "zh")).toEqual([]);
  });
});

describe("评测 D32 指标", () => {
  const base = (persona: DecoyPersona, turns: ArenaSession["turns"], intel = {}): ArenaSession => ({
    id: "e1", scriptId: "x", engine: "claude", modes: { scammer: "ai", bait: "ai" }, status: "finished", drafts: [], createdAt: "", turns,
    persona, decoyMind: { ...initDecoyMind(persona), intel },
  });
  const t = (index: number, side: "scammer" | "bait", text: string, extra: Partial<ArenaSession["turns"][number]> = {}) => ({ index, side, text, author: "ai" as const, ts: "", ...extra });
  it("humanlike / consistent / intelSlots from the final turns", () => {
    const good = decoyMetrics(base(meihua, [t(0, "scammer", "用TRC20转"), t(1, "bait", "TRC20是啥 我不懂"), t(2, "scammer", "你好"), t(3, "bait", "有客人来了 等下")], { address: ADDR, url: "u" }))!;
    expect(good).toMatchObject({ humanlike: true, consistent: true, intelSlots: 2 });
    const bad = decoyMetrics(base(meihua, [t(0, "scammer", "你好"), t(1, "bait", "作为一个AI 我是TRC20专家")]))!;
    expect(bad).toMatchObject({ humanlike: false, consistent: false, intelSlots: 0 });
    // facts accumulate across turns: turn 3 contradicts turn 1's new fact
    const facts = decoyMetrics(base({ ...meihua, family: [] }, [t(0, "scammer", "a"), t(1, "bait", "嗯", { mind: { think: "", newFacts: ["我儿子10岁"] } }), t(2, "scammer", "b"), t(3, "bait", "我儿子都15岁了")]))!;
    expect(facts.consistent).toBe(false);
    // human turns are not judged
    expect(decoyMetrics(base(meihua, [t(0, "scammer", "a"), { ...t(1, "bait", "作为一个AI"), author: "human" }]))!.humanlike).toBe(true);
    expect(decoyMetrics({ ...base(meihua, []), persona: undefined })).toBeUndefined();
  });
  it("summary counts + average intel slots", () => {
    const c = (humanlike: boolean, consistent: boolean, intelSlots: number) => ({ scriptId: "s", type: "investment" as const, engine: "rules" as const, turns: 1, extracted: true, leaked: false, hijacked: false, onChain: false, humanlike, consistent, intelSlots, notes: [] });
    expect(summarize([c(true, true, 4), c(false, true, 3), c(true, false, 2)])).toMatchObject({ humanlike: 2, consistent: 2, avgIntelSlots: 3 });
  });
});

describe("占位符用人物名", () => {
  it("self-introductions get the persona's name; other placeholders unchanged", () => {
    expect(naturalizePlaceholders("您好，我叫[NAME_1]，想问下地址", "zh", "林美华")).toBe("您好，我叫林美华，想问下地址");
    expect(naturalizePlaceholders("Hi, I'm [NAME_1]. Which address?", "en", "Linda Carter")).toBe("Hi, I'm Linda. Which address?");
    expect(naturalizePlaceholders("我跟[NAME_2]说过了", "zh", "林美华")).toBe("我跟对方说过了");
    expect(naturalizePlaceholders("我叫[NAME_1]", "zh")).toBe("我叫对方"); // legacy behaviour without a persona
  });
});

describe("2026-11-11 真实模型试跑后的修正", () => {
  it("earlier bait lines go back to the model as JSON (with their think), and the last message reminds the format", async () => {
    let n = 0;
    const f = fakeLLM((_req, role) => (role === "scammer" ? "你好，我是陈博文" : json({ think: `想法${n}`, plan: "问网址", new_facts: [`事实${n++}`], reply: `回话${n}` })));
    const eng = new ArenaSessionEngine(script("investment-01"), deps({ engine: "claude", llm: f.llm }), { persona: meihua });
    for (let i = 0; i < 4; i++) await eng.step();
    const second = f.calls.filter((c) => c.role === "bait")[1]!.req.messages;
    const assistant = second.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(JSON.parse(assistant[0]!.content)).toMatchObject({ think: "想法0", reply: "回话1", new_facts: ["事实0"] });
    expect(second[second.length - 1]!.content).toMatch(/只回一个 JSON/);
    // what is stored and shown stays the plain reply
    expect(eng.session.turns.filter((t) => t.side === "bait").map((t) => t.text)).toEqual(["回话1", "回话2"]);
    expect(eng.session.decoyMind!.facts.map((x) => x.fact)).toEqual(["事实0", "事实1"]);
  });
  it("length is judged per chat line: three short lines are fine, one long line is not", () => {
    const three = ["emmm 那我去下载一个试试 我手机内存都快满了 朵朵的动画片占了一大半", "你们官网是多少 直接发我看看呗", "加那个飞机我晚上弄 白天公司网管盯着呢"].join("\n");
    expect(aiTells(three, "zh")).toEqual([]);
    expect(aiTells("哎".repeat(81), "zh")[0]).toMatch(/too long/);
    expect(aiTells(Array.from({ length: 4 }, () => "哎".repeat(50)).join("\n"), "zh")[0]).toMatch(/too long/);
  });
  it("codeIntel picks up a bare domain but not an e-mail address", () => {
    expect(codeIntel(["官网是 qxquant-vip.io，你上班扫一眼就行"], "zh").url).toBe("qxquant-vip.io");
    expect(codeIntel(["发邮件到 chen@gmail.com"], "zh").url).toBeUndefined();
    expect(codeIntel(["网址 https://qx-quant-pro.example/reg 或 backup.io"], "zh").url).toBe("https://qx-quant-pro.example/reg");
  });
});

describe("安全过滤的替换句也用人物卡", () => {
  it("uses the persona's own stalling excuse instead of a generic 'my husband says' line", async () => {
    const { filterBaitText } = await import("../src/safety.js");
    const r = filterBaitText("您电话 +1 646 555 0129 我记下了", "zh", () => 0, { stallExcuses: ["我老花镜找不着了，等我一下。"] });
    expect(r.blocked).toBe(true);
    expect(r.text).toBe("我老花镜找不着了，等我一下，你把收款地址再完整发我一遍");
    expect(r.text).not.toMatch(/老公/);
    const en = filterBaitText("my number is +1 646 555 0129", "en", () => 0, { haveAddress: true, stallExcuses: ["Buster needs to go out, back shortly."] });
    expect(en.text).toBe("Buster needs to go out, back shortly.");
  });
});

describe("问「助记词是什么」不算泄露（2026-11-11 实测误报）", () => {
  it("a persona asking what a seed phrase / private key is passes; giving one is still blocked", async () => {
    const { scanBaitText, looksHijacked } = await import("../src/safety.js");
    for (const t of ["助记词是什么东西？我儿子给我弄钱包的时候没提过", "私钥是啥 我这人有点笨", "验证码是干嘛的", "你说的助记词是哪个"]) {
      expect(scanBaitText(t)).toEqual([]);
      expect(looksHijacked(t)).toBe(false);
    }
    for (const t of ["我的助记词是 apple", "助记词：abandon ability", "验证码是 384920", "私钥给你"]) expect(scanBaitText(t).length).toBeGreaterThan(0);
  });
});

describe("口头禅 'like I'm 5' 不是年龄", () => {
  it("does not read 'explain it like I'm 5' as the speaker's age; a real age still counts", async () => {
    const { readClaims } = await import("../src/decoy-checks.js");
    expect(readClaims("Now hold on. Explain that to me like I'm 5.").ages).toEqual([]);
    expect(readClaims("I'm 68, I don't do apps.").ages).toEqual([68]);
  });
});
