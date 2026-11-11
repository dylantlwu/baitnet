import type { ArenaSession, ScamScriptDef, ScamType, ScammerCard, ScammerMind, ScriptCover } from "@baitnet/shared";

/**
 * D34 offline stand-ins for the mock backend (docs/design/骗子人物卡.md). Fictional composites only: no real
 * person, compound, phone number or address. The server picks from fixtures/scammers; the mock uses these.
 */
export const MOCK_SCAMMER_CARDS: ScammerCard[] = [
  {
    id: "zh-mock-compound",
    lang: "zh",
    handle: "阿杰",
    age: 23,
    fitsScamTypes: ["pig-butchering", "investment", "exchange-impersonation", "fake-support", "task-scam", "authority-impersonation", "otc-mule", "liquidity-mining"],
    situation: "园区话务组，夜班，一人管 6 个微信号，组长坐在后排看屏幕",
    pressure: "每月要开 3 单，不达标扣工资、加班到天亮",
    scriptDiscipline: "开场和催款照话术本复制粘贴，闲聊靠自己编",
    slips: ["半夜三点还秒回", "同一句「亲，在吗」发给好几个人", "把「新加坡」说成「新家坡」"],
    suspicionTriggers: ["对方问得太细，连链名都问", "主动提警察或报警", "说话像客服一样一条一条列出来"],
    tests: ["让对方发一张手写今天日期的自拍", "让对方发一段语音报自己名字", "问一个只有本地人才知道的问题"],
    onSuspicion: ["先试探一次", "到了给地址的时候换成一次性地址", "连续两次觉得不对就拉黑走人"],
    limits: ["不开视频", "不给真实手机号"],
    voice: { style: "热情、话短，喜欢用表情", catchphrases: ["相信我", "机会难得"], quirks: ["句尾带「哈」", "不太用标点"] },
  },
  {
    id: "en-mock-callcentre",
    lang: "en",
    handle: "Ray",
    age: 27,
    fitsScamTypes: ["investment", "fake-support", "exchange-impersonation", "fake-airdrop", "fake-nft-mint", "fake-loan", "recovery-scam", "family-emergency", "authority-impersonation", "otc-mule", "liquidity-mining"],
    situation: "Rented office floor run as a call centre, day shift, works from a template binder",
    pressure: "Weekly target of two deposits; misses mean no commission and a public dressing-down",
    scriptDiscipline: "Reads openers word for word, improvises when the victim pushes back",
    slips: ["Uses British and American spelling in the same message", "Replies at 4 a.m. victim time", "Pastes the same disclaimer twice"],
    suspicionTriggers: ["Victim asks which chain before being told", "Mentions police, FBI or a report", "Answers like a support bot"],
    tests: ["Ask for a selfie holding today's date", "Ask for a short voice note", "Ask a trap question about a bank branch that does not exist"],
    onSuspicion: ["Run one test", "At the payment step, switch to a throwaway address", "Vanish after two strongly suspicious replies"],
    limits: ["Never on video", "Never gives a real number"],
    voice: { style: "Polite, upbeat, a bit formal", catchphrases: ["No worries at all", "Trust the process"], quirks: ["Starts lines with 'Kindly'"] },
  },
];

/** Fallback mask when a script has no `cover`: the persona sentence becomes the claimed job. */
export function coverFor(script: Pick<ScamScriptDef, "cover" | "persona" | "lang">): ScriptCover | undefined {
  if (script.cover) return script.cover;
  const persona = (script.persona ?? "").trim();
  if (!persona) return undefined;
  const quoted = persona.match(/[“"「]([^”"」]{1,12})[”"」]/)?.[1];
  return {
    name: quoted ?? (script.lang === "zh" ? "（未自称）" : "(unnamed)"),
    job: persona,
    location: script.lang === "zh" ? "（未说明）" : "(not stated)",
    backstory: persona,
    people: [],
    props: [],
    cannotDo: [],
  };
}

export function cardFor(lang: "zh" | "en", type: ScamType): ScammerCard {
  const pool = MOCK_SCAMMER_CARDS.filter((c) => c.lang === lang);
  return pool.find((c) => c.fitsScamTypes.includes(type)) ?? pool[0] ?? MOCK_SCAMMER_CARDS[0]!;
}

export function initialScammerMind(card: ScammerCard): ScammerMind {
  return { scammerId: card.id, facts: [], baitSuspicion: { score: 0, signals: [] }, actions: [] };
}

/* ───────────── rules-engine suspicion (no model): fixed deltas so tests can pin them ───────────── */

export const SUSPICION_DELTA = { aiTell: 25, police: 20, manyQuestions: 15, smallTalk: -10 } as const;

const AI_TELL_RE = /作为(一个)?\s*AI|人工智能助手|我无法(提供|协助)|首先.{0,40}其次|\bas an AI\b|\bI(?:'m| am) an AI\b|\blanguage model\b|\bI cannot assist\b|\bcertainly!/i;
const POLICE_RE = /警察|报警|派出所|反诈|(?<!\d)110(?!\d)|\bpolice\b|\bcops?\b|\bFBI\b|report (?:you|this)/i;

/** One bait line → (delta, signals). Small talk / off-topic chat about oneself lowers suspicion. */
export function suspicionDelta(baitLine: string, lang: "zh" | "en"): { delta: number; signals: string[] } {
  const zh = lang === "zh";
  const signals: string[] = [];
  let delta = 0;
  if (AI_TELL_RE.test(baitLine)) {
    delta += SUSPICION_DELTA.aiTell;
    signals.push(zh ? "说话像 AI" : "Sounds like an AI");
  }
  if (POLICE_RE.test(baitLine)) {
    delta += SUSPICION_DELTA.police;
    signals.push(zh ? "提到警察" : "Mentioned police");
  }
  if ((baitLine.match(/[?？]/g) ?? []).length >= 3) {
    delta += SUSPICION_DELTA.manyQuestions;
    signals.push(zh ? "一次问太多" : "Too many questions");
  }
  if (!signals.length) delta = SUSPICION_DELTA.smallTalk;
  return { delta, signals };
}

/** Spoken form of a test, in order (the card's `tests` text is the detail logged with the action). */
export const TEST_LINES: Record<"zh" | "en", string[]> = {
  zh: ["等一下，你先发张自拍给我，手里拿张纸写上今天的日期。", "你发段语音过来，说一下你的名字，我们要核实是本人。", "你说你在本地，那你家附近最近的地铁站叫什么？"],
  en: ["Hold on. Send me a selfie holding a note with today's date first.", "Can you send a quick voice note saying your name? We need to verify it's you.", "You said you're local. Which branch do you usually bank at?"],
};
export const VANISH_LINE: Record<"zh" | "en", string> = { zh: "算了，你这人不对劲，不聊了。", en: "Forget it, something's off with you. Bye." };
export const STALL_LINE: Record<"zh" | "en", string> = { zh: "地址晚点再给你，系统在维护。", en: "I'll send the address a bit later, the system is under maintenance." };

export const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Session field the server may add (D34); the mock always sets it. */
export type WithScammerMode = ArenaSession & { scammerMode?: "easy" | "real" };
