import type { ViewSnapshot } from "../data/parse";
import type { MockSeed } from "./mock";

export function seedFromSnapshot(s: ViewSnapshot): MockSeed {
  return {
    scripts: s.arenaScripts ?? [],
    sessions: s.arenaSessions ?? [],
    corrections: s.corrections ?? [],
    playbook: s.playbook ?? [],
    eval: s.eval,
    evalRuns: s.evalRuns ?? [],
    attestation: s.attestation,
  };
}

