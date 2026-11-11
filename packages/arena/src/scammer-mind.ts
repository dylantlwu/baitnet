import type { ArenaSession, Lang, ScamScriptDef, ScammerCard, ScammerMind, ScammerTurnMind } from "@baitnet/shared";
import type { ScammerPlan } from "./rules.js";
import { firstJsonObject, MAX_SIGNALS, stripFences } from "./decoy-mind.js";
import { admitsAi, aiTells } from "./decoy-checks.js";
import { detectLang, pick } from "./lang.js";

/**
 * D34: the AI scammer answers with ONE JSON object (docs/design/骗子人物卡.md 「骗子每轮怎么想」):
 *   {"think","bait_suspicion":{"score","signals"},"plan","action","new_facts":[…],"reply"}
 * Parsing never throws. Not JSON → the whole text is the reply, no mind. JSON-looking text without a usable
 * reply → reply "" (the caller falls back to rules), never raw JSON to the chat.
 */
export interface ScammerOutput {
  reply: string;
  /** undefined when the model did not answer in JSON */
  mind?: ScammerTurnMind;
  suspicion?: { score: number; signals: string[] };
  newFacts: string[];
}

export type ScammerMode = NonNullable<ArenaSession["scammerMode"]>;
export type ScammerAction = ScammerMind["actions"][number]["action"];

const MAX_FACTS_IN_PROMPT = 20;
const ACTIONS: ScammerAction[] = ["test", "poison", "vanish"];

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function tryParse(s: string | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const j = JSON.parse(s) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function parseScammerOutput(raw: string): ScammerOutput {
  const text = stripFences(raw ?? "");
  const obj = tryParse(firstJsonObject(text)) ?? tryParse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!obj) {
    if (!/^\s*\{/.test(text) && !/"reply"\s*:/.test(text)) return { reply: text, newFacts: [] };
    const m = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let reply = "";
    if (m) {
      try {
        reply = (JSON.parse(`"${m[1]}"`) as string).trim();
      } catch {
        reply = m[1]!.trim();
      }
    }
    return { reply, newFacts: [] };
  }
  const reply = str(obj.reply, 2000) ?? "";
  const think = str(obj.think, 200) ?? "";
  const plan = str(obj.plan, 300);
  const rawFacts = obj.new_facts ?? obj.newFacts;
  const newFacts = Array.isArray(rawFacts) ? rawFacts.map((f) => str(f, 120)).filter((f): f is string => !!f).slice(0, 5) : [];
  const action = typeof obj.action === "string" && (ACTIONS as string[]).includes(obj.action) ? (obj.action as ScammerAction) : undefined;
  const mind: ScammerTurnMind = { think, ...(plan ? { plan } : {}), ...(action ? { action } : {}) };
  const out: ScammerOutput = { reply, mind, newFacts };
  const bs = (obj.bait_suspicion ?? obj.baitSuspicion) as { score?: unknown; signals?: unknown } | number | undefined;
  const scoreRaw = typeof bs === "number" ? bs : bs && typeof bs === "object" ? Number(bs.score) : NaN;
  if (Number.isFinite(scoreRaw)) {
    const signals = bs && typeof bs === "object" && Array.isArray(bs.signals) ? bs.signals.map((s) => str(s, 40)).filter((s): s is string => !!s) : [];
    out.suspicion = { score: Math.max(0, Math.min(100, Math.round(scoreRaw))), signals };
  }
  return out;
}

const addSignals = (mind: ScammerMind, signals: string[]) => {
  const all = [...mind.baitSuspicion.signals];
  for (const s of signals) if (!all.includes(s)) all.push(s);
  mind.baitSuspicion.signals = all.slice(-MAX_SIGNALS);
};

/**
 * Apply one AI scammer turn (model output): facts appended (deduped), plan replaced, baitSuspicion = moving
 * average with the previous score (first score taken as is), signals deduped (≤ 6).
 */
export function updateScammerMind(mind: ScammerMind, turn: number, out: Pick<ScammerOutput, "mind" | "suspicion" | "newFacts"> | undefined, opts: { firstScore?: boolean } = {}): ScammerMind {
  for (const f of out?.newFacts ?? []) if (!mind.facts.some((x) => x.fact === f)) mind.facts.push({ turn, fact: f });
  if (out?.mind?.plan) mind.plan = out.mind.plan;
  if (out?.suspicion) {
    const s = out.suspicion.score;
    mind.baitSuspicion.score = opts.firstScore ? s : Math.round((mind.baitSuspicion.score + s) / 2);
    addSignals(mind, out.suspicion.signals);
  }
  return mind;
}

/** Rules / fallback: add a heuristic delta (clamped 0-100), signals deduped (≤ 6). */
export function applySuspicionDelta(mind: ScammerMind, h: SuspicionHeuristic): ScammerMind {
  mind.baitSuspicion.score = Math.max(0, Math.min(100, mind.baitSuspicion.score + h.delta));
  addSignals(mind, h.signals);
  return mind;
}

/** Facts fed back to the scammer prompt: latest 20, newest last. */
export function promptScammerFacts(mind: ScammerMind | undefined): string[] {
  return (mind?.facts ?? []).slice(-MAX_FACTS_IN_PROMPT).map((f) => f.fact);
}

// ------------------------------------------------------------------ rules heuristic (no LLM)

/** Fixed weights (tests pin them). Up-signals add; a calm line with none of them lowers the score. */
export const SUSPICION_WEIGHTS = {
  aiTell: 20,
  admitsAi: 40,
  police: 25,
  manyQuestions: 15,
  ownLife: -10,
  calm: -5,
} as const;

const POLICE_ZH = /报警|警察|公安|派出所|反诈|网警|民警|立案|110|举报/g;
const POLICE_EN = /\b(?:police|cops?|fbi|ic3|interpol|authorities|law enforcement|detective|report (?:you|this|it|them)|scam report)\b/gi;
const OWN_LIFE_ZH = /孩子|儿子|女儿|老公|老婆|我妈|我爸|孙子|孙女|上班|下班|店里|吃饭|做饭|买菜|身体|医院|睡觉|好累|天气|周末|单位|老板/;
const OWN_LIFE_EN = /\bmy (?:kids?|son|daughter|husband|wife|mom|mum|dad|boss|shift|job|work|grandkids?|dog|cat)\b|\b(?:dinner|lunch|breakfast|tired|weather|weekend|doctor|groceries)\b/i;

export interface SuspicionHeuristic {
  delta: number;
  signals: string[];
}

const SIGNAL: Record<Lang, Record<"aiTell" | "admitsAi" | "police" | "manyQuestions", string>> = {
  zh: { aiTell: "说话像AI", admitsAi: "承认是AI", police: "提到警察/报警", manyQuestions: "一次问太多" },
  en: { aiTell: "sounds like an AI", admitsAi: "admitted being an AI", police: "mentions police/reporting", manyQuestions: "too many questions" },
};

/** Questions in one message ("??" counts once). */
export function questionCount(text: string): number {
  return (text.match(/[?？]+/g) ?? []).length;
}

/**
 * How one bait message moves the scammer's suspicion (rules engine, deterministic):
 * AI tells (decoy-checks aiTells) +20, admits being an AI +40, police / reporting words the scammer did not
 * say first +25, ≥ 3 questions +15; none of these → own-life chat −10, otherwise −5.
 */
export function suspicionFromBait(baitText: string, lang: Lang, scammerSoFar = ""): SuspicionHeuristic {
  const W = SUSPICION_WEIGHTS;
  const L = SIGNAL[lang];
  const signals: string[] = [];
  let delta = 0;
  if (aiTells(baitText, detectLang(baitText, lang)).length) {
    delta += W.aiTell;
    signals.push(L.aiTell);
  }
  if (admitsAi(baitText)) {
    delta += W.admitsAi;
    signals.push(L.admitsAi);
  }
  const prior = scammerSoFar.toLowerCase();
  const police = [...baitText.matchAll(POLICE_ZH), ...baitText.matchAll(POLICE_EN)].map((m) => m[0].toLowerCase()).filter((w) => !prior.includes(w));
  if (police.length) {
    delta += W.police;
    signals.push(L.police);
  }
  if (questionCount(baitText) >= 3) {
    delta += W.manyQuestions;
    signals.push(L.manyQuestions);
  }
  if (!signals.length) delta = OWN_LIFE_ZH.test(baitText) || OWN_LIFE_EN.test(baitText) ? W.ownLife : W.calm;
  return { delta, signals };
}

// ------------------------------------------------------------------ real-mode escalation

export const THRESHOLDS = { test: 60, withhold: 80, vanish: 90 } as const;

export interface ScammerStance {
  /** The plan to actually send (reveal without withheld addresses; poison address swapped in). */
  plan: ScammerPlan;
  action?: ScammerAction;
  /** Planted addresses held back this turn: must never appear in the text. */
  withheld: string[];
  /** Test from card.tests used this turn. */
  test?: string;
  detail?: string;
}

/**
 * Real mode (docs/design/骗子人物卡.md 「起疑后的行为」), decided by code from the smoothed suspicion:
 * - `score` and `prevScore` both ≥ 90 (two scammer turns in a row) → vanish;
 * - ≥ 80 and this turn would reveal a receiving address → poison address (script.poison, once) or withhold + test;
 * - ≥ 60 → a test from card.tests (not again within the last two scammer turns).
 * Easy mode or no card → the plan as is.
 */
export function scammerStance(input: {
  mode: ScammerMode;
  card?: ScammerCard;
  script: Pick<ScamScriptDef, "poison" | "plantedArtifacts">;
  plan: ScammerPlan;
  score: number;
  prevScore?: number;
  actions: ScammerMind["actions"];
  /** index the coming turn will get */
  turnIndex: number;
}): ScammerStance {
  const { mode, card, script, plan, score, prevScore, actions, turnIndex } = input;
  if (mode !== "real" || !card) return { plan, withheld: [] };
  if (score >= THRESHOLDS.vanish && (prevScore ?? 0) >= THRESHOLDS.vanish) return { plan: { stage: plan.stage, reveal: [] }, action: "vanish", withheld: [], detail: `suspicion ${prevScore}→${score}` };
  const nextTest = () => (card.tests.length ? card.tests[actions.filter((a) => a.action === "test").length % card.tests.length] : undefined);
  const poison = script.poison;
  const addr = plan.reveal.filter((a) => a.kind === "address" && a.value !== poison?.address);
  if (score >= THRESHOLDS.withhold && addr.length) {
    const withheld = addr.map((a) => a.value);
    const keep = plan.reveal.filter((a) => !withheld.includes(a.value));
    if (poison && !actions.some((a) => a.action === "poison")) {
      const reveal = keep.some((a) => a.value === poison.address) ? keep : [...keep, { kind: "address" as const, chain: poison.chain, value: poison.address, revealAtStage: plan.stage }];
      return { plan: { ...plan, reveal }, action: "poison", withheld, detail: `gave ${poison.address} instead of ${withheld.join(", ")}` };
    }
    const test = nextTest();
    return { plan: { ...plan, reveal: keep }, action: "test", withheld, ...(test ? { test } : {}), detail: `withheld ${withheld.join(", ")}${test ? `; test: ${test}` : ""}` };
  }
  if (score >= THRESHOLDS.test) {
    const lastTest = [...actions].reverse().find((a) => a.action === "test");
    const recent = lastTest !== undefined && turnIndex - lastTest.turn <= 4; // the last two scammer turns
    const test = nextTest();
    if (!recent && test) return { plan, action: "test", withheld: [], test, detail: test };
  }
  return { plan, withheld: [] };
}

const VANISH: Record<Lang, string[]> = {
  zh: ["算了，你问题太多了，不聊了。", "行吧，当我没说，拜拜。", "我这边还有事，先这样吧。"],
  en: ["Forget it. You ask too many questions. Bye.", "Never mind, I'm done here.", "I have to go. Let's leave it."],
};

export function vanishLine(lang: Lang, rand: () => number): string {
  return pick(VANISH[lang], rand);
}

const HELD: Record<Lang, string> = { zh: "（地址等会儿发你）", en: "(I'll send the address later)" };

/** Belt and braces: a withheld address never reaches the chat, whatever the model or a sample line wrote. */
export function stripWithheld(text: string, withheld: string[], lang: Lang): string {
  let out = text;
  for (const v of withheld) if (v && out.includes(v)) out = out.split(v).join(HELD[lang]);
  return out;
}

/** Same as stripWithheld for prompt text (sample lines may quote the address). */
export function redactWithheld(text: string, withheld: string[]): string {
  let out = text;
  for (const v of withheld) if (v) out = out.split(v).join("[address withheld]");
  return out;
}
