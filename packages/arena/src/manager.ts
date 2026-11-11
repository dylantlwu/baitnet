import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ARENA_MODEL, type ArenaEvent, type ArenaModelChoice, type ArenaSession, type ArenaSide, type ScamScriptDef, type SideMode } from "@baitnet/shared";
import { MemoryRegistryClient, SampleAccountInfo, type RegistryClient } from "@baitnet/guard";
import { AccountAgeCheck, KnownEntityFilter, RuntimeMissingError, dataPath, fixturePath, loadEnv, loadKnownEntities, onchainLookupFromEnv } from "@baitnet/agent";
import { ArenaSessionEngine, validateRating, type SessionDeps } from "./session.js";
import { resolvePersonaId } from "./personas.js";
import type { SessionChannel, SessionRating } from "@baitnet/shared";
import { arenaModelOptions, defaultRetriever, isArenaModelChoice, loadScripts, selectArenaEngine, selectArenaModel, training, type PlaybookRetriever, type TrainingModule } from "./deps.js";

export const sessionsDir = () => dataPath("arena", "sessions");

export function saveSession(s: ArenaSession) {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(join(sessionsDir(), `${s.id}.json`), JSON.stringify(s, null, 2));
}

export function readSessions(): ArenaSession[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as ArenaSession;
      } catch {
        return null;
      }
    })
    .filter((s): s is ArenaSession => !!s)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Registry for reviews: chain if data/runtime.json exists, else the shared file-backed memory registry. */
export function defaultRegistry(): RegistryClient {
  try {
    return loadEnv().registry;
  } catch (e) {
    if (!(e instanceof RuntimeMissingError)) throw e;
    return new MemoryRegistryClient({ caller: "reporter.memory", persistPath: dataPath("memory-registry.json"), contractId: "registry.memory" });
  }
}

export interface ManagerOptions extends Partial<Omit<SessionDeps, "persist" | "llmGate">> {
  persist?: boolean;
  scripts?: ScamScriptDef[];
  /** Per-owner daily LLM quota (IdentityService.consumeLlmQuota); omitted = unlimited. */
  llmQuota?: (ownerId: string) => boolean | Promise<boolean>;
  /** env for the model selection (tests); default process.env */
  env?: NodeJS.ProcessEnv;
}

/** Holds live sessions for the server (and eval). */
export class ArenaManager {
  private sessions = new Map<string, ArenaSessionEngine>();
  private scriptsCache?: ScamScriptDef[];
  private retriever?: PlaybookRetriever;

  constructor(private opts: ManagerOptions = {}) {}

  /** Always fresh (fixtures + uploaded scripts): a script saved in Script Lab shows up immediately. */
  async scripts(_refresh = false): Promise<ScamScriptDef[]> {
    if (this.opts.scripts) return this.opts.scripts;
    this.scriptsCache = await loadScripts();
    return this.scriptsCache;
  }

  /**
   * After a process restart: bring unfinished sessions from data/arena/sessions
   * back as live (paused) engines so they can be continued and reviewed.
   */
  async restore(): Promise<number> {
    const scripts = await this.scripts();
    let n = 0;
    for (const saved of readSessions()) {
      if (saved.status === "finished" || this.sessions.has(saved.id)) continue;
      const script = scripts.find((s) => s.id === saved.scriptId);
      if (!script) {
        this.opts.log?.(`[arena] cannot restore ${saved.id}: script ${saved.scriptId} missing`);
        continue;
      }
      const eng = ArenaSessionEngine.restore(script, { ...(await this.deps(saved.modelChoice)), llmGate: this.gateFor(saved.channel) }, saved);
      this.sessions.set(eng.session.id, eng);
      if (this.opts.persist !== false) saveSession(eng.session);
      n++;
    }
    if (n) this.opts.log?.(`[arena] restored ${n} unfinished session(s) as paused`);
    return n;
  }

  private trainingMod?: TrainingModule;

  /** Persist to data/arena/sessions and (if B2's training package is present) to training.sqlite. */
  private persistFn(): ((s: ArenaSession) => void) | undefined {
    if (this.opts.persist === false) return undefined;
    return (s) => {
      saveSession(s);
      try {
        void this.trainingMod?.saveSession?.(s);
      } catch (e) {
        this.opts.log?.(`[arena] training.saveSession failed: ${(e as Error).message}`);
      }
    };
  }

  /**
   * `modelChoice` (D30) picks the provider; undefined = the legacy env-driven selection (sessions saved
   * before D30). opts.engine/llm (tests/eval) override both.
   */
  async deps(modelChoice?: ArenaModelChoice): Promise<SessionDeps> {
    if (this.opts.persist !== false) this.trainingMod ??= await training();
    const env = this.opts.env ?? process.env;
    const sel = this.opts.engine
      ? { engine: this.opts.engine, llm: this.opts.llm }
      : modelChoice
        ? selectArenaModel(modelChoice, env)
        : selectArenaEngine(env);
    this.retriever ??= this.opts.retriever ?? (await defaultRetriever());
    return {
      engine: sel.engine,
      llm: sel.llm,
      ...(modelChoice ? { modelChoice } : {}),
      registry: this.opts.registry ?? defaultRegistry(),
      retriever: this.retriever,
      known: this.opts.known ?? new KnownEntityFilter(loadKnownEntities()),
      age: this.opts.age ?? new AccountAgeCheck(SampleAccountInfo.fromFile(fixturePath("account-meta.json"))),
      // D33: real contract / activity lookup only with BAITNET_ONCHAIN_LOOKUP=on; otherwise a no-network stub
      onchain: this.opts.onchain ?? onchainLookupFromEnv(env),
      autoApprove: this.opts.autoApprove,
      stepDelayMs: this.opts.stepDelayMs ?? 0,
      maxTurns: this.opts.maxTurns,
      now: this.opts.now,
      log: this.opts.log,
      persist: this.persistFn(),
    };
  }

  private gateFor(channel?: SessionChannel): SessionDeps["llmGate"] {
    const q = this.opts.llmQuota;
    return q && channel?.ownerId ? () => q(channel.ownerId) : undefined;
  }

  /** D30 model list with what this server can run (no key / offline → all unavailable = rules). */
  models() {
    const o = arenaModelOptions(this.opts.env ?? process.env);
    if (!this.opts.engine) return o;
    // injected engine (tests/eval): every choice runs on it
    const ok = this.opts.engine !== "rules";
    return { ...o, liveLLM: ok, models: o.models.map((m) => ({ ...m, available: ok })) };
  }

  /**
   * `channel` records where the session lives (web / telegram / lark) and who owns it.
   * `modelChoice` (D30): deepseek | glm | sonnet, default DEFAULT_ARENA_MODEL; unknown → 400.
   * `personaId` (D32, optional): play this character card (fixtures/personas); default = stable pick by session id.
   */
  async create(
    scriptId: string,
    modes: Partial<Record<ArenaSide, SideMode>> = {},
    channel?: SessionChannel,
    modelChoice: ArenaModelChoice = DEFAULT_ARENA_MODEL,
    personaId?: string,
  ): Promise<ArenaSessionEngine> {
    if (!isArenaModelChoice(modelChoice)) throw Object.assign(new Error(`unknown model ${String(modelChoice)}`), { status: 400 });
    const script = (await this.scripts()).find((s) => s.id === scriptId);
    if (!script) throw Object.assign(new Error(`unknown script ${scriptId}`), { status: 404 });
    const persona = personaId !== undefined ? resolvePersonaId(personaId, script.lang) : undefined;
    const eng = new ArenaSessionEngine(script, { ...(await this.deps(modelChoice)), llmGate: this.gateFor(channel) }, { modes, channel, ...(persona ? { persona } : {}) });
    this.sessions.set(eng.session.id, eng);
    if (this.opts.persist !== false) saveSession(eng.session);
    return eng;
  }

  /** Rate a live or stored session; also stored in training.sqlite via B2's saveSession(s, {expertId, score}). */
  async rate(id: string, r: { expertId?: unknown; score?: unknown; note?: unknown }): Promise<ArenaSession> {
    const rating: SessionRating = validateRating(r, this.opts.now?.() ?? new Date());
    const eng = this.sessions.get(id);
    let s: ArenaSession | undefined;
    if (eng) {
      eng.session.rating = rating;
      s = eng.session;
    } else {
      s = readSessions().find((x) => x.id === id);
      if (!s) throw Object.assign(new Error("session not found"), { status: 404 });
      s.rating = rating;
    }
    if (this.opts.persist !== false) {
      saveSession(s);
      this.trainingMod ??= await training();
      try {
        await this.trainingMod.saveSession?.(s, { expertId: rating.expertId, score: rating.score });
      } catch (e) {
        this.opts.log?.(`[arena] training.saveSession failed: ${(e as Error).message}`);
      }
    }
    return s;
  }

  /** id/type/lang/title catalog for the dashboard and the hosted snapshot. */
  async catalog() {
    return (await this.scripts()).map(({ id, type, lang, title }) => ({ id, type, lang, title }));
  }

  get(id: string): ArenaSessionEngine | undefined {
    return this.sessions.get(id);
  }


  /** Live sessions first, then finished ones from disk. */
  list(): ArenaSession[] {
    const live = [...this.sessions.values()].map((e) => e.session);
    const ids = new Set(live.map((s) => s.id));
    return [...readSessions().filter((s) => !ids.has(s.id)), ...live];
  }

  subscribe(id: string, fn: (e: ArenaEvent) => void): () => void {
    const eng = this.sessions.get(id);
    if (!eng) throw Object.assign(new Error("session not live"), { status: 404 });
    eng.on("event", fn);
    return () => eng.off("event", fn);
  }

  /** Sessions (live + stored) owned by `ownerId` (SessionChannel.ownerId), newest first. */
  listByOwner(ownerId: string): ArenaSession[] {
    return this.list()
      .filter((s) => s.channel?.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stopAll() {
    for (const e of this.sessions.values()) e.pause();
  }
}
