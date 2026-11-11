import { existsSync, readFileSync } from "node:fs";
import { fixturePath } from "@baitnet/agent";
import type { Lang, ScamScriptDef, ScammerCard, ScammerMind } from "@baitnet/shared";
import { stableHash } from "./personas.js";

/**
 * D34 scammer operator cards (docs/design/骗子人物卡.md): fixtures/scammers/{zh,en}.json, product-owned
 * content. A session picks one (script.scammerId, else by type + hash of the session id, else the language's
 * first card) and keeps a snapshot on ArenaSession.scammer together with the script's `cover`.
 * No card at all (fixtures missing) → the scammer side behaves exactly as before D34.
 */

const cache = new Map<string, ScammerCard[]>();

const strs = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === "string");

const isCard = (c: unknown): c is ScammerCard => {
  const x = c as ScammerCard;
  return (
    !!x &&
    typeof x.id === "string" &&
    typeof x.handle === "string" &&
    (x.lang === "zh" || x.lang === "en") &&
    Array.isArray(x.fitsScamTypes) &&
    strs(x.tests) &&
    strs(x.suspicionTriggers) &&
    strs(x.onSuspicion) &&
    !!x.voice
  );
};

/** All scammer cards of a language (fixtures/scammers/<lang>.json); malformed entries are skipped, missing file → []. */
export function loadScammerCards(lang: Lang, dir = fixturePath("scammers")): ScammerCard[] {
  const key = `${dir}:${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = `${dir}/${lang}.json`;
  let out: ScammerCard[] = [];
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
      out = (Array.isArray(j) ? j : []).filter(isCard).filter((c) => c.lang === lang);
    } catch {
      out = [];
    }
  }
  cache.set(key, out);
  return out;
}

/**
 * Pick the operator card: script.scammerId (same language) if it exists; else among the cards whose
 * fitsScamTypes include the script type, one by hash(session id) (salted, so it is independent of the
 * decoy persona pick); else the language's first card; none → undefined.
 */
export function selectScammerCard(
  script: Pick<ScamScriptDef, "type" | "lang" | "scammerId">,
  sessionId: string,
  cards: ScammerCard[] = loadScammerCards(script.lang),
): ScammerCard | undefined {
  const sameLang = cards.filter((c) => c.lang === script.lang);
  if (script.scammerId) {
    const pinned = sameLang.find((c) => c.id === script.scammerId);
    if (pinned) return pinned;
  }
  const fits = sameLang.filter((c) => c.fitsScamTypes.includes(script.type));
  if (!fits.length) return sameLang[0];
  return fits[stableHash(`scammer:${sessionId}`) % fits.length];
}

export function initScammerMind(card: ScammerCard): ScammerMind {
  return { scammerId: card.id, facts: [], baitSuspicion: { score: 0, signals: [] }, actions: [] };
}
