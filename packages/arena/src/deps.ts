import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArenaEngine, Correction, EvalRun, PlaybookEntry, PlaybookQuery, ScamScriptDef } from "@baitnet/shared";
import { allowLiveLLM, fixturePath, NearAIProvider, REPO_ROOT, DEFAULT_NEARAI_MODEL, selectClaudeProvider, type LLMProvider } from "@baitnet/agent";

export interface PlaybookRetriever {
  search(q: PlaybookQuery): PlaybookEntry[] | Promise<PlaybookEntry[]>;
}
export const emptyRetriever: PlaybookRetriever = { search: () => [] };

export interface RegressionCase {
  id: string;
  scriptId: string;
  prefix: { side: "scammer" | "bait"; text: string }[];
  badReply: string;
  correction: Correction;
}

/** Optional exports of B2's packages (docs/dev/server-routes.md §4). */
export interface TrainingModule {
  createTagRetriever?: () => PlaybookRetriever;
  listRegressionCases?: () => RegressionCase[] | Promise<RegressionCase[]>;
  judgeRegression?: (c: RegressionCase, reply: string) => { pass: boolean; reasons?: string[] } | boolean | Promise<{ pass: boolean; reasons?: string[] } | boolean>;
  recordEvalRun?: (run: Omit<EvalRun, "id" | "at" | "playbookVersion"> & { playbookVersion?: number }) => EvalRun | Promise<EvalRun>;
  getPlaybookVersion?: () => number | Promise<number>;
  listPlaybook?: () => PlaybookEntry[] | Promise<PlaybookEntry[]>;
  listCorrections?: () => Correction[] | Promise<Correction[]>;
  listEvalRuns?: () => EvalRun[] | Promise<EvalRun[]>;
  listUploadedScripts?: () => ScamScriptDef[] | Promise<ScamScriptDef[]>;
  /** B2: store an arena session (sessions/turns tables) so corrections/regressions can replay it */
  saveSession?: (s: import("@baitnet/shared").ArenaSession, meta?: { expertId?: string; score?: number }) => void | Promise<void>;
  registerTrainingRoutes?: (router: unknown, ctx: unknown) => void | Promise<void>;
  registerScriptLabRoutes?: (router: unknown, ctx: unknown) => void | Promise<void>;
}

const cache = new Map<string, TrainingModule | null>();
/** Try `@baitnet/<name>`, then packages/<name>/src/index.ts; null if B2 hasn't shipped it. */
export async function tryImport(name: "training" | "scriptlab"): Promise<TrainingModule | null> {
  if (cache.has(name)) return cache.get(name)!;
  let mod: TrainingModule | null = null;
  try {
    mod = (await import(`@baitnet/${name}`)) as TrainingModule;
  } catch {
    const p = join(REPO_ROOT, "packages", name, "src", "index.ts");
    if (existsSync(p)) {
      try {
        mod = (await import(pathToFileURL(p).href)) as TrainingModule;
      } catch {
        mod = null;
      }
    }
  }
  cache.set(name, mod);
  return mod;
}
export function resetImportCache() {
  cache.clear();
}

/** Merged view of training + scriptlab exports. */
export async function training(): Promise<TrainingModule> {
  const [t, s] = await Promise.all([tryImport("training"), tryImport("scriptlab")]);
  return { ...(s ?? {}), ...(t ?? {}) };
}

export async function defaultRetriever(): Promise<PlaybookRetriever> {
  const t = await training();
  try {
    return t.createTagRetriever?.() ?? emptyRetriever;
  } catch {
    return emptyRetriever;
  }
}

// ------------------------------------------------------------------ scripts
export function loadFixtureScripts(dir = fixturePath("scripts")): ScamScriptDef[] {
  if (!existsSync(dir)) return [];
  const out: ScamScriptDef[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const s of Array.isArray(j) ? j : [j]) if (s?.id && Array.isArray(s.stages)) out.push(s as ScamScriptDef);
    } catch {
      /* skip malformed file */
    }
  }
  return out;
}

/** fixtures/scripts/*.json + uploaded scripts from B2 (if available). Uploaded ids win on clash? No — built-ins win. */
export async function loadScripts(): Promise<ScamScriptDef[]> {
  const builtin = loadFixtureScripts();
  let uploaded: ScamScriptDef[] = [];
  try {
    uploaded = (await (await training()).listUploadedScripts?.()) ?? [];
  } catch {
    uploaded = [];
  }
  const ids = new Set(builtin.map((s) => s.id));
  return [...builtin, ...uploaded.filter((s) => !ids.has(s.id))];
}

// ------------------------------------------------------------------ LLM
/**
 * nearai (TEE) → claude → rules; offline mode (BAITNET_MODE=offline/testnet) forces rules.
 * "claude" = direct with ANTHROPIC_API_KEY, else Claude via NEAR AI (Incognito, not TEE) with NEARAI_API_KEY;
 * with only a NEAR AI key the default stays the TEE model (BAITNET_ARENA_ENGINE=claude switches).
 */
export function selectArenaEngine(env: NodeJS.ProcessEnv = process.env): { engine: ArenaEngine; llm?: LLMProvider } {
  const forced = env.BAITNET_ARENA_ENGINE as ArenaEngine | undefined;
  if (forced === "rules" || !allowLiveLLM(env)) return { engine: "rules" };
  if ((forced === "nearai" || !forced) && env.NEARAI_API_KEY) return { engine: "nearai", llm: new NearAIProvider(env.NEARAI_API_KEY, env.NEARAI_MODEL || DEFAULT_NEARAI_MODEL) };
  if (forced === "claude" || !forced) {
    const llm = selectClaudeProvider(env);
    if (llm) return { engine: "claude", llm };
  }
  return { engine: "rules" };
}
