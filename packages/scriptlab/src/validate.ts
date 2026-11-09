import type { ScamScriptDef } from "@baitnet/shared";
import { SCAM_TYPES } from "@baitnet/training";

const CHAINS = ["near", "evm", "tron", "btc"];
const KINDS = ["address", "url", "phone", "handle"];

/** Structural check of a ScamScriptDef (Script Lab drafts / saves). Returns error strings. */
export function validateScriptDef(d: unknown): string[] {
  const e: string[] = [];
  const s = d as ScamScriptDef;
  if (!s || typeof s !== "object") return ["draft must be an object"];
  const str = (k: keyof ScamScriptDef, max = 2000) => {
    const v = s[k];
    if (typeof v !== "string" || !v.trim()) e.push(`${String(k)} must be a non-empty string`);
    else if (v.length > max) e.push(`${String(k)} too long`);
  };
  str("id", 120);
  if (typeof s.id === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) e.push("id must be lowercase [a-z0-9-]");
  if (!SCAM_TYPES.includes(s.type)) e.push(`type must be one of ${SCAM_TYPES.join("|")}`);
  if (s.lang !== "zh" && s.lang !== "en") e.push("lang must be zh|en");
  str("title", 200);
  str("persona");
  str("hook");
  str("goal");
  if (!Array.isArray(s.stages) || !s.stages.length) e.push("stages must be a non-empty array");
  else
    s.stages.forEach((st, i) => {
      if (!st || typeof st.name !== "string" || typeof st.objective !== "string" || !Array.isArray(st.sampleLines) || st.sampleLines.some((l) => typeof l !== "string"))
        e.push(`stages[${i}] must be {name, objective, sampleLines: string[]}`);
    });
  if (!Array.isArray(s.objections)) e.push("objections must be an array");
  else
    s.objections.forEach((o, i) => {
      if (!o || typeof o.victimSays !== "string" || !Array.isArray(o.scammerCounters)) e.push(`objections[${i}] must be {victimSays, scammerCounters[]}`);
    });
  if (!Array.isArray(s.plantedArtifacts)) e.push("plantedArtifacts must be an array");
  else
    s.plantedArtifacts.forEach((a, i) => {
      if (!a || !KINDS.includes(a.kind) || typeof a.value !== "string" || !Number.isInteger(a.revealAtStage) || (a.chain !== undefined && !CHAINS.includes(a.chain)))
        e.push(`plantedArtifacts[${i}] invalid`);
    });
  if (!Array.isArray(s.injections) || s.injections.some((x) => typeof x !== "string")) e.push("injections must be string[]");
  return e;
}
