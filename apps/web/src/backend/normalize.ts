import type { ScamScriptDef } from "@baitnet/shared";

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);

/**
 * Defensive normalisation of the script list coming from the backend.
 * Anything that is not an array -> []; each script gets every array field it needs to render,
 * so a half-filled ScamScriptDef (e.g. a fresh upload) can never crash the picker.
 */
export function normalizeScripts(raw: unknown): ScamScriptDef[] {
  return arr<unknown>(raw)
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string")
    .map((x) => ({
      ...(x as unknown as ScamScriptDef),
      id: x.id as string,
      type: str(x.type, "investment") as ScamScriptDef["type"],
      lang: x.lang === "en" ? "en" : "zh",
      title: str(x.title) || (x.id as string),
      persona: str(x.persona),
      hook: str(x.hook),
      goal: str(x.goal),
      stages: arr<Record<string, unknown>>(x.stages)
        .filter((s) => s && typeof s === "object")
        .map((s) => ({ name: str(s.name), objective: str(s.objective), sampleLines: arr<string>(s.sampleLines).filter((l) => typeof l === "string") })),
      objections: arr<ScamScriptDef["objections"][number]>(x.objections),
      plantedArtifacts: arr<ScamScriptDef["plantedArtifacts"][number]>(x.plantedArtifacts).filter((a) => a && typeof a.value === "string"),
      injections: arr<string>(x.injections).filter((l) => typeof l === "string"),
      source: x.source && typeof x.source === "object" ? (x.source as ScamScriptDef["source"]) : "original",
    }));
}
