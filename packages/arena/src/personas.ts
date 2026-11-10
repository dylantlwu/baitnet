import { existsSync, readFileSync } from "node:fs";
import { fixturePath } from "@baitnet/agent";
import type { DecoyMind, DecoyPersona, Lang, ScamScriptDef } from "@baitnet/shared";

/**
 * D32 decoy personas (docs/design/诱饵心智.md 「选人」): character cards in fixtures/personas/{zh,en}.json,
 * product-owned content. A session picks one per script type + language, stably by session id, and keeps
 * a snapshot on ArenaSession.persona.
 */

const cache = new Map<string, DecoyPersona[]>();

const isPersona = (p: unknown): p is DecoyPersona => {
  const x = p as DecoyPersona;
  return !!x && typeof x.id === "string" && typeof x.name === "string" && (x.lang === "zh" || x.lang === "en") && Array.isArray(x.fitsScamTypes) && Array.isArray(x.stallExcuses) && Array.isArray(x.doesNotKnow) && !!x.voice;
};

/** All persona cards of a language (fixtures/personas/<lang>.json); malformed entries are skipped. */
export function loadPersonas(lang: Lang, dir = fixturePath("personas")): DecoyPersona[] {
  const key = `${dir}:${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = `${dir}/${lang}.json`;
  let out: DecoyPersona[] = [];
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
      out = (Array.isArray(j) ? j : []).filter(isPersona).filter((p) => p.lang === lang);
    } catch {
      out = [];
    }
  }
  cache.set(key, out);
  return out;
}

export function allPersonas(): DecoyPersona[] {
  return [...loadPersonas("zh"), ...loadPersonas("en")];
}

export function findPersona(id: string): DecoyPersona | undefined {
  return allPersonas().find((p) => p.id === id);
}

/** FNV-1a 32-bit: small, stable across processes (Math.random / Map order never decide a persona). */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 选人: among the cards of the script's language whose fitsScamTypes include the script type, pick one by
 * hash(sessionId) — same session, same person, always. No fitting card → the language's first card.
 */
export function selectPersona(script: Pick<ScamScriptDef, "type" | "lang">, sessionId: string, personas: DecoyPersona[] = loadPersonas(script.lang)): DecoyPersona | undefined {
  const sameLang = personas.filter((p) => p.lang === script.lang);
  const fits = sameLang.filter((p) => p.fitsScamTypes.includes(script.type));
  if (!fits.length) return sameLang[0];
  return fits[stableHash(sessionId) % fits.length];
}

/** Explicit choice (POST /arena/sessions {personaId}): must exist and speak the script's language. */
export function resolvePersonaId(personaId: string, lang: Lang): DecoyPersona {
  const p = findPersona(personaId);
  if (!p) throw Object.assign(new Error(`unknown persona ${personaId}`), { status: 400 });
  if (p.lang !== lang) throw Object.assign(new Error(`persona ${personaId} is ${p.lang}, script is ${lang}`), { status: 400 });
  return p;
}

export function initDecoyMind(persona: DecoyPersona): DecoyMind {
  return { personaId: persona.id, facts: [], intel: {}, scammerAi: { score: 0, signals: [] }, checks: [] };
}

/** "Linda Carter" → "Linda"; Chinese names stay whole. */
export function firstName(p: Pick<DecoyPersona, "name" | "lang">): string {
  return p.lang === "en" ? (p.name.split(/\s+/)[0] ?? p.name) : p.name;
}
