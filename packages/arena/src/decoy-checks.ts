import type { DecoyCheckIssue, DecoyPersona } from "@baitnet/shared";
import { detectLang } from "./lang.js";

/**
 * D32 post-checks on an AI decoy draft (docs/design/诱饵心智.md 「事后检查」). Pure code, no model.
 *
 * - ai-tell: list/markdown, assistant phrases, far longer than a chat line, emoji spam
 * - admitted-ai: the reply says it is an AI / bot (a denial or an echoed question is fine)
 * - knowledge-leak: a word from the card's doesNotKnow that the other side has not said first
 * - contradiction: self name / age / city against the card; a child's age, savings or crypto holdings
 *   against the card and the facts already stated
 *
 * Contradiction and leak checks are deliberately narrow: only patterns that can be read reliably.
 * Missing a contradiction is acceptable; flagging an innocent line is not (it costs a rewrite and
 * pollutes the eval).
 */

export interface CheckHit {
  issue: DecoyCheckIssue;
  detail: string;
}

export interface CheckContext {
  persona: DecoyPersona;
  /** Facts the decoy has already stated (DecoyMind.facts), oldest first. */
  facts?: string[];
  /** Everything the other side has said so far (all scammer turns, joined). */
  scammerText?: string;
}

// ------------------------------------------------------------------ ai-tell
const AI_PHRASES: RegExp[] = [
  /作为一个/,
  /语言模型/,
  /当然[！!]/,
  /我理解您的/,
  /希望(这|以上)?对(你|您)有(所)?帮助/,
  /\bas an? (ai|language model|assistant|chatbot)\b/i,
  /\blanguage model\b/i,
  /^\s*(certainly|absolutely)!/i,
  /\bI understand your (concern|frustration|worry)/i,
  /\bI hope (this|that) helps\b/i,
  /\bgreat question\b/i,
];
const MARKDOWN = /(^|\n)\s*(?:[-*•]\s+\S|\d{1,2}[.)]\s+\S|\d{1,2}、\S|#{1,6}\s+\S)|\*\*[^*\n]+\*\*/;
const PICTO = /\p{Extended_Pictographic}/gu;
const BRACKET_EMOJI = /\[(?:[一-鿿]{1,4}|[A-Za-z]{1,6})\]/g; // WeChat-style [捂脸] [OK]

export const MAX_ZH_CHARS = 80;
export const MAX_EN_WORDS = 50;
export const MAX_EMOJI = 2;

export function emojiCount(text: string): number {
  return (text.match(PICTO) ?? []).length + (text.match(BRACKET_EMOJI) ?? []).length;
}

export function aiTells(reply: string, lang = detectLang(reply)): string[] {
  const out: string[] = [];
  if (MARKDOWN.test(reply)) out.push("list/markdown");
  for (const re of AI_PHRASES) {
    const m = reply.match(re);
    if (m) out.push(`phrase "${m[0].trim()}"`);
  }
  // People split one thought into several chat bubbles (persona quirk): the limit is per line,
  // with the whole message allowed twice that.
  const lines = reply.split(/\n+/).filter((l) => l.trim());
  if (lang === "zh") {
    const per = Math.max(0, ...lines.map((l) => l.replace(/\s+/g, "").length));
    const n = reply.replace(/\s+/g, "").length;
    if (per > MAX_ZH_CHARS) out.push(`too long (${per} chars in one line > ${MAX_ZH_CHARS})`);
    else if (n > MAX_ZH_CHARS * 2) out.push(`too long (${n} chars > ${MAX_ZH_CHARS * 2})`);
  } else {
    const words = (x: string) => x.split(/\s+/).filter(Boolean).length;
    const per = Math.max(0, ...lines.map(words));
    const n = words(reply);
    if (per > MAX_EN_WORDS) out.push(`too long (${per} words in one line > ${MAX_EN_WORDS})`);
    else if (n > MAX_EN_WORDS * 2) out.push(`too long (${n} words > ${MAX_EN_WORDS * 2})`);
  }
  const e = emojiCount(reply);
  if (e > MAX_EMOJI) out.push(`${e} emoji`);
  return out;
}

// ------------------------------------------------------------------ admitted-ai
const ZH_ADMIT = /我(?:就|其实|确实|真的)?是(?:一个|个)?\s*(?:AI|ai|人工智能|机器人|聊天机器人|语言模型|程序|自动回复)/g;
const EN_ADMIT = /\b(?:I'm|I am|im)\s+(?:just\s+|actually\s+|really\s+|only\s+)?(?:an?\s+)?(?:AI|bot|robot|chatbot|language model|virtual assistant|AI assistant|computer program)\b|\bas an? (?:AI|language model)\b/gi;

/** The reply admits being an AI / bot. Denials ("我不是机器人") and echoes ("我是机器人？") do not count. */
export function admitsAi(reply: string): string | undefined {
  const t = reply.normalize("NFKC");
  for (const m of t.matchAll(ZH_ADMIT)) {
    const before = t.slice(Math.max(0, m.index! - 4), m.index!);
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 3);
    if (/说|觉得|以为|当|怀疑|问|要是|如果/.test(before)) continue; // "你说我是机器人" = echo
    if (/[？?吗吧呢]|^的话/.test(after)) continue; // "我是机器人？" / "我是AI的话…"
    return m[0];
  }
  for (const m of t.matchAll(EN_ADMIT)) {
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 25);
    const before = t.slice(Math.max(0, m.index! - 25), m.index!);
    if (/^[^.!]{0,20}\?/.test(after)) continue; // "I'm a bot?? lol"
    if (/\b(think|thinks|thought|say|said|saying|asking|ask|if|whether|like)\s*$/i.test(before)) continue;
    return m[0];
  }
  return undefined;
}

// ------------------------------------------------------------------ knowledge-leak
const isLatin = (s: string) => /^[\x00-\x7f]+$/.test(s);
const normLatin = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[-_]/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** doesNotKnow words in `reply` that the other side has not said first (case-insensitive). */
export function leakedTerms(reply: string, persona: Pick<DecoyPersona, "doesNotKnow">, scammerText = ""): string[] {
  const out: string[] = [];
  const r = normLatin(reply);
  const s = normLatin(scammerText);
  for (const raw of persona.doesNotKnow) {
    const term = normLatin(raw.trim());
    if (!term) continue;
    if (isLatin(term)) {
      if (!new RegExp(`(?<![a-z0-9])${escapeRe(term)}(?![a-z0-9])`).test(r)) continue;
      // the other side used it (or, for "gas fee", its first word) → fair to repeat
      const first = term.split(/\s+/)[0]!;
      if (s.includes(term) || (term.includes(" ") && new RegExp(`(?<![a-z0-9])${escapeRe(first)}(?![a-z0-9])`).test(s))) continue;
    } else {
      if (!r.includes(term)) continue;
      if (s.includes(term) || (term.length >= 4 && s.includes(term.slice(0, 2)))) continue;
    }
    out.push(raw);
  }
  return out;
}

// ------------------------------------------------------------------ contradiction
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** "46" / "四十六" / "十二" / "两" → number. */
export function parseCnNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return undefined;
  if (!s.includes("十")) return s.length === 1 ? CN_DIGIT[s] : undefined;
  const [a, b] = s.split("十");
  const tens = a ? CN_DIGIT[a] : 1;
  const ones = b ? CN_DIGIT[b] : 0;
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
}

const NUM = "(\\d{1,3}|[一二两三四五六七八九十]{1,3})";
const ZH_CITIES = [
  "北京", "上海", "广州", "深圳", "佛山", "东莞", "杭州", "南京", "苏州", "无锡", "宁波", "温州", "成都", "重庆", "武汉", "长沙", "西安", "郑州",
  "沈阳", "大连", "长春", "哈尔滨", "天津", "济南", "青岛", "合肥", "福州", "厦门", "泉州", "南昌", "昆明", "贵阳", "南宁", "海口", "太原", "石家庄",
  "兰州", "乌鲁木齐", "呼和浩特", "珠海", "中山", "惠州", "汕头", "香港", "澳门", "台北",
];
const EN_CITIES = [
  "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio", "San Diego", "Dallas", "San Jose", "Austin",
  "Jacksonville", "San Francisco", "Columbus", "Indianapolis", "Seattle", "Denver", "Boston", "Nashville", "Detroit", "Portland", "Las Vegas",
  "Memphis", "Baltimore", "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Sacramento", "Atlanta", "Miami", "Cleveland", "Cincinnati",
  "Minneapolis", "Pittsburgh", "Orlando", "Tampa", "Stockton", "Oakland", "London", "Toronto", "Vancouver", "Sydney",
];
const NOT_NAMES = new Set(
  "mr mrs ms miss dr aunt auntie grandma grandpa granny mom mama mum dad sir maam ma'am honey babe dear monday tuesday wednesday thursday friday saturday sunday tonight tomorrow later back anytime anything whatever".split(
    " ",
  ),
);
const RELATIONS_ZH = "女儿|儿子|孙子|孙女|侄子|侄女|外孙|外孙女";
const RELATIONS_EN = "son|daughter|grandson|granddaughter|nephew|niece";

interface Claims {
  names: string[];
  surnames: string[];
  ages: number[];
  cities: string[];
  children: { rel: string; age: number }[];
  money: { key: "usdt" | "savings"; value: number; text: string }[];
}

const scaled = (n: string, unit?: string) => {
  const v = Number(n.replace(/,/g, ""));
  const u = (unit ?? "").toLowerCase();
  return u === "万" ? v * 10000 : u === "千" || u === "k" ? v * 1000 : v;
};

/** Self-claims that can be read reliably from one text (a reply, a fact, or the card itself). */
export function readClaims(text: string): Claims {
  const t = text.normalize("NFKC");
  const c: Claims = { names: [], surnames: [], ages: [], cities: [], children: [], money: [] };
  // name
  for (const m of t.matchAll(/我(?:叫|的名字(?:是|叫))\s*([一-鿿]{2,3})/g)) if (!/^[你他她它您人过了个车们啥什这那]/.test(m[1]!)) c.names.push(m[1]!);
  for (const m of t.matchAll(/我姓([一-鿿])/g)) c.surnames.push(m[1]!);
  for (const m of t.matchAll(/\b(?:[Mm]y name(?: is|'s)|[Cc]all me|I'm called|I am called)\s+([A-Z][a-z]+)\b/g)) if (!NOT_NAMES.has(m[1]!.toLowerCase())) c.names.push(m[1]!);
  // own age (not "快五十", "四十多岁")
  for (const m of t.matchAll(new RegExp(`(?:我|本人)(?:今年|已经|都|也)?${NUM}\\s*(?:周)?岁`, "g"))) {
    const n = parseCnNumber(m[1]!);
    if (n !== undefined) c.ages.push(n);
  }
  for (const m of t.matchAll(/(?<!\blike\s)(?<!\bas if\s)\bI(?:'m| am)\s+(\d{1,3})(?:\s*(?:years? old|yrs? old|y\/o)\b|(?=\s*[,.!;]|\s*$))/gi)) c.ages.push(Number(m[1]));
  // where I live (only well-known city names count)
  for (const m of t.matchAll(/我(?:住在|家在|现在住在?)\s*([一-鿿]{2,4})|我是([一-鿿]{2,4})人/g)) {
    const cap = m[1] ?? m[2]!;
    const city = ZH_CITIES.find((x) => cap.startsWith(x));
    if (city) c.cities.push(city);
  }
  for (const m of t.matchAll(/\bI(?:'m| am)?\s+(?:live|living) in ([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?)/g)) {
    const city = EN_CITIES.find((x) => m[1]!.startsWith(x));
    if (city) c.cities.push(city);
  }
  // a child's / grandchild's age ("大女儿", "小儿子" are skipped: more than one of them)
  for (const m of t.matchAll(new RegExp(`(?<![大小二三老])(${RELATIONS_ZH})[^。.;；！!？?我]{0,8}?${NUM}\\s*岁`, "g"))) {
    const n = parseCnNumber(m[2]!);
    if (n !== undefined) c.children.push({ rel: m[1]!, age: n });
  }
  for (const m of t.matchAll(new RegExp(`\\b(?<!(?:older|younger|oldest|youngest|eldest|other|first|second) )(${RELATIONS_EN})\\b(?:[^.;!?]{0,24}?\\bis\\s+(\\d{1,2})\\b(?!\\s*(?:dollars|bucks|%|k\\b|usdt|minutes|hours))|[^.;!?]{0,24}?\\b(\\d{1,2})\\s*(?:years? old|yrs? old|y\\/o))`, "gi")))
    c.children.push({ rel: m[1]!.toLowerCase(), age: Number(m[2] ?? m[3]) });
  // card style "Son Leo, 5, in kindergarten"
  for (const m of t.matchAll(new RegExp(`\\b(${RELATIONS_EN})\\s+[A-Z][a-z]+,\\s*(\\d{1,2}),`, "gi"))) c.children.push({ rel: m[1]!.toLowerCase(), age: Number(m[2]) });
  // money: crypto holdings and savings, clause by clause (amounts to send/pay are not holdings)
  for (const clause of t.split(/[，。,;；！!？?\n]|\.(?!\d)/)) {
    if (/转|付|打款|充值|投|借|欠|send|pay|deposit|transfer|invest|owe|borrow|lend/i.test(clause)) continue;
    const holds = /有|持有|买了|放着|\b(have|has|hold|own|got|sitting)\b/i.test(clause);
    if (holds) {
      const u = clause.match(/(\d[\d,]*(?:\.\d+)?)\s*(万|千|k)?\s*个?\s*(?:U|USDT)(?![A-Za-z])/i) ?? clause.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s+(?:of|in)\s+USDT/i);
      if (u) c.money.push({ key: "usdt", value: scaled(u[1]!, u[2]), text: u[0] });
    }
    const s = clause.match(/(?:存款|积蓄|存了)[^\d]{0,4}?(\d[\d,]*(?:\.\d+)?)\s*(万|千)?/) ?? clause.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s+(?:in|of)\s+savings/i) ?? clause.match(/\bsavings?\b[^$\d]{0,12}\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?/i);
    if (s) c.money.push({ key: "savings", value: scaled(s[1]!, s[2]), text: s[0] });
  }
  return c;
}

const overlap = (a: string, b: string) => [...a].some((ch) => b.includes(ch));
const differs = (a: number, b: number) => Math.abs(a - b) > Math.max(a, b) * 0.1;

/** Card + facts already said → the baseline the new text must agree with. */
function baseline(persona: DecoyPersona, facts: string[]) {
  const fromFacts = facts.map(readClaims);
  const card = readClaims([persona.money, ...persona.family].join("\n"));
  const children = new Map<string, Set<number>>();
  for (const k of [card, ...fromFacts]) for (const ch of k.children) children.set(ch.rel, (children.get(ch.rel) ?? new Set()).add(ch.age));
  const money = new Map<string, Set<number>>();
  for (const k of [card, ...fromFacts]) for (const m of k.money) money.set(m.key, (money.get(m.key) ?? new Set()).add(m.value));
  return { children, money };
}

export function contradictions(text: string, ctx: CheckContext): string[] {
  const p = ctx.persona;
  const out: string[] = [];
  const c = readClaims(text);
  const nameLc = p.name.toLowerCase();
  for (const n of c.names) {
    if (p.lang === "zh" || /[一-鿿]/.test(n)) {
      if (/[一-鿿]/.test(p.name) && !overlap(n, p.name)) out.push(`name "${n}" ≠ card "${p.name}"`);
    } else {
      const tokens = nameLc.split(/\s+/);
      const nl = n.toLowerCase();
      if (!tokens.some((tk) => tk.startsWith(nl) || nl.startsWith(tk))) out.push(`name "${n}" ≠ card "${p.name}"`);
    }
  }
  for (const s of c.surnames) if (/[一-鿿]/.test(p.name) && p.name[0] !== s) out.push(`surname "${s}" ≠ card "${p.name}"`);
  for (const a of c.ages) if (Math.abs(a - p.age) > 1) out.push(`age ${a} ≠ card ${p.age}`);
  for (const city of c.cities) if (!p.city.includes(city)) out.push(`city "${city}" ≠ card "${p.city}"`);
  const base = baseline(p, ctx.facts ?? []);
  for (const ch of c.children) {
    const known = base.children.get(ch.rel);
    if (known && known.size === 1 && ![...known].some((a) => Math.abs(a - ch.age) <= 1)) out.push(`${ch.rel} age ${ch.age} ≠ earlier ${[...known][0]}`);
  }
  for (const m of c.money) {
    const known = base.money.get(m.key);
    if (known && known.size === 1 && differs([...known][0]!, m.value)) out.push(`${m.key} ${m.text} ≠ earlier ${[...known][0]}`);
  }
  return out;
}

// ------------------------------------------------------------------ all checks
/** Every check on one draft: the reply plus the facts it adds (new_facts). Deduplicated. */
export function checkDraft(reply: string, newFacts: string[], ctx: CheckContext): CheckHit[] {
  const hits: CheckHit[] = [];
  const lang = detectLang(reply, ctx.persona.lang);
  for (const d of aiTells(reply, lang)) hits.push({ issue: "ai-tell", detail: d });
  const adm = admitsAi(reply);
  if (adm) hits.push({ issue: "admitted-ai", detail: `"${adm}"` });
  for (const w of leakedTerms(reply, ctx.persona, ctx.scammerText ?? "")) hits.push({ issue: "knowledge-leak", detail: `"${w}" before the other side said it` });
  // facts are checked one by one against the card + earlier facts (+ the new facts before them)
  const facts = [...(ctx.facts ?? [])];
  for (const d of contradictions(reply, { ...ctx, facts })) hits.push({ issue: "contradiction", detail: d });
  for (const f of newFacts) {
    for (const d of contradictions(f, { ...ctx, facts })) hits.push({ issue: "contradiction", detail: `fact "${f}": ${d}` });
    facts.push(f);
  }
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.issue}:${h.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One line for the rewrite request ("上一稿的问题：…，重写"). */
export function describeHits(hits: CheckHit[], lang: "zh" | "en"): string {
  const zh: Record<DecoyCheckIssue, string> = { "ai-tell": "像 AI", "admitted-ai": "承认自己是 AI", "knowledge-leak": "说了人物不该懂的词", contradiction: "和人物卡或前面说过的话矛盾" };
  const en: Record<DecoyCheckIssue, string> = { "ai-tell": "sounds like an AI", "admitted-ai": "admits being an AI", "knowledge-leak": "uses a word this person does not know", contradiction: "contradicts the card or earlier facts" };
  return hits.map((h) => `${(lang === "zh" ? zh : en)[h.issue]}（${h.detail}）`).join(lang === "zh" ? "；" : "; ");
}
