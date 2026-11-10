import type { Lang, PlaybookEntry } from "@baitnet/shared";

/**
 * PII placeholders in the playbook (D15 / M13).
 *
 * Corrections and playbook rows are redacted on write by @baitnet/training's Redactor: names, phones,
 * handles… become `[NAME_1]`, `[PHONE_2]`. That is right for storage (an expert's rewrite may quote a
 * real victim), but the redactor cannot tell a fictional persona name ("陈老师" in a scam script, or the
 * decoy's own fake name) from a real one, so a rewrite like "陈老师，我再想想" is stored as
 * "[NAME_1]，我再想想". Fed verbatim to the decoy as an example, the decoy learns to say "[NAME_1]".
 *
 * So storage stays redacted, and every playbook example is "naturalized" right before it reaches the
 * decoy (LLM prompt or rules engine): vocative names are dropped ("[NAME_1]，您好" → "您好"), other
 * placeholders become a natural generic phrase ("对方", "那个号码", "that number"). An example that
 * still contains a placeholder afterwards is filtered out.
 */

export const PLACEHOLDER_RE = /\[(NAME|PHONE|EMAIL|ID|CARD|ADDR|HANDLE)_\d+\]/g;
export const hasPlaceholder = (s: string | undefined) => !!s && /\[(?:NAME|PHONE|EMAIL|ID|CARD|ADDR|HANDLE)_\d+\]/.test(s);

const GENERIC: Record<Lang, Record<string, string>> = {
  zh: { NAME: "对方", PHONE: "那个号码", EMAIL: "那个邮箱", ID: "证件号", CARD: "卡号", ADDR: "那个地址", HANDLE: "那个账号" },
  en: { NAME: "them", PHONE: "that number", EMAIL: "that email", ID: "the ID number", CARD: "the card number", ADDR: "that address", HANDLE: "that account" },
};

/** Replace PII placeholders with natural wording a decoy can actually say. */
export function naturalizePlaceholders(text: string, lang: Lang): string {
  if (!hasPlaceholder(text)) return text;
  const N = "\\[NAME_\\d+\\]";
  let t = text;
  if (lang === "zh") {
    // vocative at the start or before 您/你 ("[NAME_1]，您好" / "[NAME_1]您说"): drop it
    t = t.replace(new RegExp(`^\\s*${N}\\s*[，,、:：!！~～]?\\s*`, "g"), "");
    t = t.replace(new RegExp(`${N}(?=\\s*(?:您|你))`, "g"), "");
    t = t.replace(new RegExp(`([。！？!?，,]\\s*)${N}\\s*[，,、:：]\\s*`, "g"), "$1");
  } else {
    // "Hi [NAME_1]," / "Thanks [NAME_1]" / "[NAME_1], ..." → drop the name
    t = t.replace(new RegExp(`\\b(Hi|Hello|Hey|Dear|Thanks|Thank you|Sorry|OK|Okay)\\s+${N}`, "gi"), "$1");
    t = t.replace(new RegExp(`^\\s*${N}\\s*[,:!]\\s*`, "g"), "");
    t = t.replace(new RegExp(`,\\s*${N}(?=\\s*[.!?]|$)`, "g"), "");
  }
  t = t.replace(PLACEHOLDER_RE, (_m, kind: string) => GENERIC[lang][kind] ?? GENERIC[lang].NAME!);
  if (lang === "en") t = t.replace(/^([a-z])/, (c) => c.toUpperCase());
  return t.replace(/\s{2,}/g, " ").trim();
}

/** Playbook examples ready for the decoy: placeholders naturalized; anything still unusable dropped. */
export function decoyReadyPlaybook(entries: PlaybookEntry[], lang: Lang): PlaybookEntry[] {
  return entries
    .map((e) => ({
      ...e,
      situation: naturalizePlaceholders(e.situation, lang),
      badReply: e.badReply ? naturalizePlaceholders(e.badReply, lang) : e.badReply,
      goodReply: naturalizePlaceholders(e.goodReply, lang),
      rationale: e.rationale ? naturalizePlaceholders(e.rationale, lang) : e.rationale,
    }))
    .filter((e) => e.goodReply.trim() && ![e.situation, e.badReply, e.goodReply, e.rationale].some(hasPlaceholder));
}
