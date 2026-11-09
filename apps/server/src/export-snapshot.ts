/** Writes apps/web/public/snapshot.json (static hosted demo, D13). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "@baitnet/agent";
import { DataSource } from "./data.js";
import { ArenaManager, ensureDemoSessions, readLatestReport, runEval } from "@baitnet/arena";
import { getAttestation } from "./attestation.js";

const out = process.env.SNAPSHOT_OUT ?? join(REPO_ROOT, "apps/web/public/snapshot.json");
const data = new DataSource((s) => console.log(s));
// offline unless BAITNET_MODE=live / BAITNET_LIVE_ATTESTATION=1 (see @baitnet/agent mode.ts)
const attestation = await getAttestation({ log: (s) => console.warn(s) });
// scorecard: run the offline eval once if there is no report yet (rules engine, in-memory registry)
if (!readLatestReport()) {
  const r = await runEval({ log: () => {} });
  console.log(`eval: ${r.summary.extracted}/${r.summary.total} extracted (engine ${r.engine})`);
}
// hosted replay needs ≥3 recorded arena sessions incl. a scammer takeover and a whisper
const arena = new ArenaManager({ registry: data.registry, engine: "rules", log: (s) => console.log(s) });
await ensureDemoSessions(arena, { log: (s) => console.log(s) });
const snap = await data.snapshot(attestation, arena);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snap, null, 2));
console.log(`snapshot → ${out}: ${snap.alerts.length} alerts, ${snap.events.length} events, ${snap.conversations.length} conversations, ${Object.keys(snap.evidence ?? {}).length} evidence, ${snap.arenaSessions?.length ?? 0} arena sessions, ${snap.arenaScripts?.length ?? 0} scripts, eval ${snap.eval ? "yes" : "no"}, ${snap.evalRuns?.length ?? 0} eval runs, ${snap.playbook?.length ?? 0} playbook, ${snap.corrections?.length ?? 0} corrections, attestation ${attestation.recorded ? "recorded" : "live"} verified=${attestation.verified}`);
data.stop();
