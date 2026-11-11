import { INTEL_SLOTS, type ArenaSession, type DecoyMind, type DecoyTurnMind, type IntelSlot } from "@baitnet/shared";
import { extractFromText } from "@baitnet/agent";
import { CHAIN_NAME } from "./lang.js";

/**
 * D32: the decoy model answers with ONE JSON object (docs/design/诱饵心智.md 「每轮流程」):
 *   {"think","scammer_ai":{"score","signals"},"plan","intel":{…},"new_facts":[…],"reply"}
 * Parsing never throws. Not JSON → the whole text (code fences stripped) is the reply and there is no mind.
 * JSON-looking text without a usable reply → reply "" (the caller falls back), never raw JSON to the chat.
 */
export interface DecoyOutput {
  reply: string;
  /** undefined when the model did not answer in JSON */
  mind?: DecoyTurnMind;
  scammerAi?: { score: number; signals: string[] };
  intel?: Partial<Record<IntelSlot, string>>;
}

const MAX_FACTS_IN_PROMPT = 20;
export const MAX_SIGNALS = 6;

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function stripFences(text: string): string {
  return text
    .replace(/```(?:json|JSON)?\s*/g, "")
    .replace(/```/g, "")
    .trim();
}

/** First balanced {...} in `text` (string-aware), or undefined. */
export function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

function tryParse(s: string | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const j = JSON.parse(s) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function parseDecoyOutput(raw: string): DecoyOutput {
  const text = stripFences(raw ?? "");
  const obj = tryParse(firstJsonObject(text)) ?? tryParse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!obj) {
    if (!/^\s*\{/.test(text) && !/"reply"\s*:/.test(text)) return { reply: text };
    // broken / truncated JSON: salvage the reply string if it is complete, never send JSON to the chat
    const m = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let reply = "";
    if (m) {
      try {
        reply = (JSON.parse(`"${m[1]}"`) as string).trim();
      } catch {
        reply = m[1]!.trim();
      }
    }
    return { reply };
  }
  const reply = str(obj.reply, 2000) ?? "";
  const think = str(obj.think, 200) ?? "";
  const plan = str(obj.plan, 300);
  const newFacts = Array.isArray(obj.new_facts ?? obj.newFacts)
    ? ((obj.new_facts ?? obj.newFacts) as unknown[]).map((f) => str(f, 120)).filter((f): f is string => !!f).slice(0, 5)
    : [];
  const mind: DecoyTurnMind = { think, ...(plan ? { plan } : {}), ...(newFacts.length ? { newFacts } : {}) };
  const out: DecoyOutput = { reply, mind };
  const sa = (obj.scammer_ai ?? obj.scammerAi) as { score?: unknown; signals?: unknown } | undefined;
  if (sa && typeof sa === "object") {
    const score = Number(sa.score);
    if (Number.isFinite(score))
      out.scammerAi = {
        score: Math.max(0, Math.min(100, Math.round(score))),
        signals: Array.isArray(sa.signals) ? sa.signals.map((s) => str(s, 40)).filter((s): s is string => !!s) : [],
      };
  }
  if (obj.intel && typeof obj.intel === "object") {
    const intel: Partial<Record<IntelSlot, string>> = {};
    for (const k of INTEL_SLOTS) {
      const v = (obj.intel as Record<string, unknown>)[k];
      const s = typeof v === "number" ? String(v) : str(v, 200);
      if (s && !/^(无|没有|未知|缺|none|n\/a|unknown|null|-|—)$/i.test(s)) intel[k] = s;
    }
    if (Object.keys(intel).length) out.intel = intel;
  }
  return out;
}

/**
 * Intel the code can read from the other side's messages: first/second receiving address (+ chain),
 * first URL, a Telegram handle or phone. Code wins over the model for address / backupAddress / url.
 */
const BARE_DOMAIN = /(?<![@\w.-])((?:[a-z0-9-]+\.)+(?:io|com|net|org|xyz|app|vip|top|cc|me|co|pro|site|online|link|finance|club|info|biz|live|exchange))(?![\w-])/gi;

export function codeIntel(scammerTexts: string[], lang: "zh" | "en"): Partial<Record<IntelSlot, string>> {
  const addrs: { chain: string; address: string; hint?: string }[] = [];
  const urls: string[] = [];
  const contacts: string[] = [];
  for (const t of scammerTexts) {
    const ex = extractFromText(t);
    for (const a of ex.addresses) if (!addrs.some((x) => x.address === a.address)) addrs.push({ chain: a.chain, address: a.address, hint: a.assetHint });
    for (const u of ex.urls) if (!urls.includes(u)) urls.push(u);
    for (const c of [...ex.telegrams, ...ex.phones]) if (!contacts.includes(c)) contacts.push(c);
  }
  const out: Partial<Record<IntelSlot, string>> = {};
  if (addrs[0]) {
    out.address = addrs[0].address;
    out.chain = CHAIN_NAME[lang][addrs[0].chain] ?? addrs[0].chain;
    if (addrs[0].hint) out.token = addrs[0].hint;
  }
  if (addrs[1]) out.backupAddress = addrs[1].address;
  if (!urls.length) {
    // scammers often write a bare domain ("qxquant-vip.io"); only common scam TLDs, never e-mail addresses
    for (const t of scammerTexts) {
      for (const m of t.matchAll(BARE_DOMAIN)) if (!urls.includes(m[1]!)) urls.push(m[1]!);
    }
  }
  if (urls[0]) out.url = urls[0];
  if (contacts[0]) out.contact = contacts[0];
  return out;
}

/** Hard slots (address / backupAddress / url) come from code when it found one; others: code fills gaps. */
export function mergeIntel(
  prev: DecoyMind["intel"],
  model: Partial<Record<IntelSlot, string>> | undefined,
  code: Partial<Record<IntelSlot, string>>,
): DecoyMind["intel"] {
  const out: DecoyMind["intel"] = { ...prev, ...(model ?? {}) };
  for (const k of INTEL_SLOTS) {
    const v = code[k];
    if (!v) continue;
    if (k === "address" || k === "backupAddress" || k === "url") out[k] = v;
    else out[k] ??= v;
  }
  return out;
}

/**
 * Apply one AI bait turn to the session's mind: facts appended, intel merged, plan replaced,
 * scammerAi = moving average with the previous score (first score taken as is), signals deduped (≤ 6).
 */
export function updateDecoyMind(
  mind: DecoyMind,
  turn: number,
  out: Pick<DecoyOutput, "mind" | "scammerAi" | "intel"> | undefined,
  code: Partial<Record<IntelSlot, string>>,
  opts: { firstScore?: boolean } = {},
): DecoyMind {
  for (const f of out?.mind?.newFacts ?? []) if (!mind.facts.some((x) => x.fact === f)) mind.facts.push({ turn, fact: f });
  mind.intel = mergeIntel(mind.intel, out?.intel, code);
  if (out?.mind?.plan) mind.plan = out.mind.plan;
  if (out?.scammerAi) {
    const s = out.scammerAi.score;
    mind.scammerAi.score = opts.firstScore ? s : Math.round((mind.scammerAi.score + s) / 2);
    const signals = [...mind.scammerAi.signals];
    for (const sig of out.scammerAi.signals) if (!signals.includes(sig)) signals.push(sig);
    mind.scammerAi.signals = signals.slice(-MAX_SIGNALS);
  }
  return mind;
}

/** Facts fed back to the prompt: latest 20, newest last. */
export function promptFacts(mind: DecoyMind | undefined): string[] {
  return (mind?.facts ?? []).slice(-MAX_FACTS_IN_PROMPT).map((f) => f.fact);
}

/** Filled intel slots (eval `intelSlots`). */
export function intelCount(mind: DecoyMind | undefined): number {
  return INTEL_SLOTS.filter((k) => !!mind?.intel[k]).length;
}

/**
 * A session without either side's hidden state: the decoy's (persona card, decoyMind, turn.mind) and, since
 * D34, the scammer's (operator card + cover, scammerMind, turn.scammerMind). For anything outside the
 * logged-in team, e.g. the public hosted snapshot.
 */
export function withoutDecoyMind<T extends ArenaSession>(s: T): T {
  const { persona: _p, decoyMind: _m, scammer: _c, scammerMind: _sm, ...rest } = s;
  return { ...rest, turns: s.turns.map(({ mind: _x, scammerMind: _y, ...t }) => t) } as unknown as T;
}

/** Same as withoutDecoyMind (both minds stripped); the D34 name. */
export const withoutHiddenMinds = withoutDecoyMind;
