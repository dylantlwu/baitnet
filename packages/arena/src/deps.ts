import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ARENA_MODELS, DEFAULT_ARENA_MODEL, type ArenaModelChoice, type ArenaModelInfo } from "@baitnet/shared";
import type { ArenaEngine, Correction, EvalRun, PlaybookEntry, PlaybookQuery, ScamScriptDef } from "@baitnet/shared";
import {
  allowLiveLLM,
  fixturePath,
  NearAIProvider,
  NEARAI_BASE_URL,
  NO_THINKING,
  REPO_ROOT,
  DEFAULT_NEARAI_MODEL,
  selectClaudeProvider,
  type LLMProvider,
  type NearAIOptions,
} from "@baitnet/agent";

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

// ------------------------------------------------------------------ D30: per-session model choice
export const ARENA_MODEL_IDS = ARENA_MODELS.map((m) => m.id) as ArenaModelChoice[];
export function isArenaModelChoice(v: unknown): v is ArenaModelChoice {
  return typeof v === "string" && (ARENA_MODEL_IDS as string[]).includes(v);
}

/** Env var that overrides each choice's NEAR AI model id (empty = the ARENA_MODELS default). */
export const ARENA_MODEL_ENV: Record<ArenaModelChoice, string> = {
  deepseek: "NEARAI_MODEL_DEEPSEEK",
  glm: "NEARAI_MODEL_GLM",
  haiku: "NEARAI_CLAUDE_HAIKU_MODEL",
  sonnet: "NEARAI_CLAUDE_MODEL",
};
/** Claude choices (Claude channel: ANTHROPIC_API_KEY direct, else via NEAR AI) and their direct-API model ids. */
const CLAUDE_DIRECT: Partial<Record<ArenaModelChoice, { env: string; model: string }>> = {
  haiku: { env: "CLAUDE_HAIKU_MODEL", model: "claude-haiku-5-5" },
  sonnet: { env: "CLAUDE_MODEL", model: "claude-sonnet-5-5" },
};
export const isClaudeChoice = (c: ArenaModelChoice) => c in CLAUDE_DIRECT;

/**
 * Per-model request options. DeepSeek: thinking off (measured: 0 reasoning tokens, ~2 s).
 * GLM 5.3 Flash always thinks (300–1,200 reasoning tokens, 7–28 s, measured 2026-11-10) and
 * `enable_thinking:false` only leaks the reasoning into the reply — so no kwargs, a 2,000-token budget instead.
 */
const NEARAI_OPTIONS: Partial<Record<ArenaModelChoice, NearAIOptions>> = {
  deepseek: { extraBody: NO_THINKING },
  glm: { minMaxTokens: 2000 },
};

const infoOf = (c: ArenaModelChoice): ArenaModelInfo => ARENA_MODELS.find((m) => m.id === c)!;

/** The concrete model id a choice resolves to on NEAR AI Cloud (env override, `||` so "" = default). */
export function arenaModelId(choice: ArenaModelChoice, env: NodeJS.ProcessEnv = process.env): string {
  return env[ARENA_MODEL_ENV[choice]] || infoOf(choice).model;
}

/** Engine + provider for an explicit model choice; rules when offline / forced rules / no usable key. */
export function selectArenaModel(choice: ArenaModelChoice, env: NodeJS.ProcessEnv = process.env): { engine: ArenaEngine; llm?: LLMProvider } {
  if (env.BAITNET_ARENA_ENGINE === "rules" || !allowLiveLLM(env)) return { engine: "rules" };
  const direct = CLAUDE_DIRECT[choice];
  if (direct) {
    // ANTHROPIC_API_KEY → direct, else Claude via NEAR AI (max_tokens floor + empty-reply retry: NearAIClaudeProvider)
    const llm = selectClaudeProvider(env, { direct: env[direct.env] || direct.model, nearai: arenaModelId(choice, env) });
    return llm ? { engine: "claude", llm } : { engine: "rules" };
  }
  if (!env.NEARAI_API_KEY) return { engine: "rules" };
  return { engine: "nearai", llm: new NearAIProvider(env.NEARAI_API_KEY, arenaModelId(choice, env), env.NEARAI_BASE_URL || NEARAI_BASE_URL, NEARAI_OPTIONS[choice]) };
}

export interface ArenaModelOption extends ArenaModelInfo {
  /** true = this server can run it now; false = a session with it falls back to the rules engine */
  available: boolean;
  /** Claude choices only: "anthropic" (direct key) or "nearai" */
  via?: "anthropic" | "nearai";
}

/** GET /arena/models: the D30 list with the resolved model ids and what this server can actually run. */
export function arenaModelOptions(env: NodeJS.ProcessEnv = process.env): { default: ArenaModelChoice; liveLLM: boolean; models: ArenaModelOption[] } {
  const models = ARENA_MODELS.map((m): ArenaModelOption => {
    const sel = selectArenaModel(m.id, env);
    const via = sel.llm?.via === "anthropic" || sel.llm?.via === "nearai" ? sel.llm.via : undefined;
    return { ...m, price: { ...m.price }, model: sel.llm?.model ?? arenaModelId(m.id, env), available: sel.engine !== "rules", ...(isClaudeChoice(m.id) && via ? { via } : {}) };
  });
  return { default: DEFAULT_ARENA_MODEL, liveLLM: models.some((m) => m.available), models };
}

/** Relative price (by output price vs the cheapest option) for the pickers: cheapest / cheap / pricey (≥ 4×). */
export function arenaModelTier(choice: ArenaModelChoice, list: readonly Pick<ArenaModelInfo, "id" | "price">[] = ARENA_MODELS): "cheapest" | "cheap" | "pricey" {
  const m = list.find((x) => x.id === choice);
  if (!m) return "cheap";
  const min = Math.min(...list.map((x) => x.price.output));
  return m.price.output >= 4 * min ? "pricey" : m.price.output === min ? "cheapest" : "cheap";
}
