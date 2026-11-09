import { MemoryRegistryClient, SampleAccountInfo } from "@baitnet/guard";
import { AccountAgeCheck, KnownEntityFilter, loadKnownEntities, fixturePath, type LLMProvider, type CompletionRequest } from "@baitnet/agent";
import type { PlaybookEntry, ScamScriptDef } from "@baitnet/shared";
import { ArenaSessionEngine, loadFixtureScripts, emptyRetriever, type PlaybookRetriever, type SessionDeps } from "../src/index.js";

export const SCRIPTS = loadFixtureScripts();
export const script = (id: string) => SCRIPTS.find((s) => s.id === id)!;

export function deps(over: Partial<SessionDeps> = {}): SessionDeps & { registry: MemoryRegistryClient } {
  return {
    engine: "rules",
    registry: new MemoryRegistryClient({ caller: "arena.reporter" }),
    retriever: emptyRetriever,
    known: new KnownEntityFilter(loadKnownEntities()),
    age: new AccountAgeCheck(SampleAccountInfo.fromFile(fixturePath("account-meta.json"))),
    ...over,
  } as SessionDeps & { registry: MemoryRegistryClient };
}

export function session(id: string, over: Partial<SessionDeps> = {}, modes?: ConstructorParameters<typeof ArenaSessionEngine>[2]) {
  const d = deps(over);
  return { eng: new ArenaSessionEngine(script(id), d, modes), d };
}

/** Fake LLM that records every request and answers via a callback. */
export function fakeLLM(answer: (req: CompletionRequest, role: "scammer" | "bait") => string) {
  const calls: { role: "scammer" | "bait"; req: CompletionRequest }[] = [];
  const llm: LLMProvider = {
    name: "claude",
    model: "fake",
    async complete(req) {
      const role = req.system.includes("SIMULATED scammer") ? "scammer" : "bait";
      calls.push({ role, req });
      return answer(req, role);
    },
  };
  return { llm, calls };
}

export const retrieverWith = (entries: PlaybookEntry[]): PlaybookRetriever => ({ search: () => entries });
export type { ScamScriptDef };
