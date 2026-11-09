import type {
  ArenaSession,
  Correction,
  EvalReport,
  EvalRun,
  PlaybookEntry,
  ScamScriptDef,
  Ack,
  AlertView,
  AttestationResult,
  Conversation,
  DemoSnapshot,
  FlowEdge,
  GuardEvent,
  Responder,
} from "@baitnet/shared";

/**
 * DemoSnapshot plus front-end extensions.
 * `arenaScripts` is NOT in the shared contract yet: the hosted replay needs script metadata (title/type/lang).
 */
export interface ViewSnapshot extends DemoSnapshot {
  arenaScripts?: ScamScriptDef[];
}

export class SnapshotParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SnapshotParseError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function numKeyed<T>(v: unknown, map: (x: unknown) => T | undefined): Record<number, T> {
  const out: Record<number, T> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    const n = Number(k);
    if (!Number.isFinite(n)) continue;
    const m = map(val);
    if (m !== undefined) out[n] = m;
  }
  return out;
}

function normAlert(a: unknown): AlertView | null {
  if (!isObj(a)) return null;
  if (typeof a.address !== "string" || typeof a.chain !== "string") return null;
  return {
    conversationId: typeof a.conversationId === "string" ? a.conversationId : undefined,
    id: Number(a.id),
    chain: a.chain as AlertView["chain"],
    address: a.address,
    level: (a.level as AlertView["level"]) ?? "L1",
    category: String(a.category ?? "unknown"),
    evidenceHash: String(a.evidenceHash ?? "").toLowerCase().replace(/^0x/, ""),
    status: (a.status as AlertView["status"]) ?? "Active",
    reporter: String(a.reporter ?? ""),
    createdAt: String(a.createdAt ?? ""),
    txHash: typeof a.txHash === "string" ? a.txHash : undefined,
  };
}

export function normalizeAlerts(raw: unknown): AlertView[] {
  const list = isObj(raw) && Array.isArray(raw.alerts) ? raw.alerts : raw;
  return arr<unknown>(list)
    .map(normAlert)
    .filter((a): a is AlertView => a !== null)
    .sort((a, b) => a.id - b.id);
}

export function isGuardEvent(v: unknown): v is GuardEvent {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    (v.source === "agent-wallet" || v.source === "intents-solver") &&
    isObj(v.verdict) &&
    typeof (v.verdict as Record<string, unknown>).kind === "string"
  );
}

export function normalizeEvent(v: GuardEvent): GuardEvent {
  return { ...v, log: arr<string>(v.log), verdict: { ...v.verdict, reasons: arr(v.verdict.reasons) } };
}

/** Sort newest first. */
export const byTimeDesc = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/**
 * Report the network truthfully. Older exports from the in-memory registry say network "sandbox"
 * but name the contract "registry.memory"; the contract name wins.
 */
export function snapshotNetwork(network: unknown, registry: unknown): DemoSnapshot["network"] {
  if (network === "memory" || (typeof registry === "string" && /(^|\.)memory$/i.test(registry))) return "memory";
  if (network === "testnet" || (typeof registry === "string" && /\.testnet$/i.test(registry))) return "testnet";
  return "sandbox";
}

/** Validate + normalize anything that claims to be a DemoSnapshot. Throws SnapshotParseError. */
export function parseSnapshot(raw: unknown): ViewSnapshot {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new SnapshotParseError("snapshot is not valid JSON");
    }
  }
  if (!isObj(raw)) throw new SnapshotParseError("snapshot must be a JSON object");
  if (!Array.isArray(raw.alerts)) throw new SnapshotParseError("snapshot.alerts must be an array");

  const conversations = arr<Conversation>(raw.conversations).filter(
    (c) => isObj(c) && typeof c.id === "string" && Array.isArray(c.turns),
  );
  const events = arr<unknown>(raw.events).filter(isGuardEvent).map(normalizeEvent).sort(byTimeDesc);
  const flows = numKeyed<FlowEdge[]>(raw.flows, (v) =>
    Array.isArray(v) ? (v.filter((e) => isObj(e) && typeof e.from === "string" && typeof e.to === "string") as FlowEdge[]) : undefined,
  );
  const evidence = numKeyed<string>(raw.evidence, (v) => (typeof v === "string" ? v : undefined));
  const att = isObj(raw.attestation) && Array.isArray(raw.attestation.checks) ? (raw.attestation as unknown as AttestationResult) : undefined;

  return {
    generatedAt: String(raw.generatedAt ?? new Date(0).toISOString()),
    network: snapshotNetwork(raw.network, raw.registryContract),
    registryContract: String(raw.registryContract ?? ""),
    alerts: normalizeAlerts(raw.alerts),
    conversations,
    events,
    flows,
    responders: arr<Responder>(raw.responders),
    acks: arr<Ack>(raw.acks),
    attestation: att,
    evidence: Object.keys(evidence).length ? evidence : undefined,
    arenaSessions: arr<ArenaSession>(raw.arenaSessions).filter((x) => isObj(x) && typeof x.id === "string" && Array.isArray(x.turns)),
    arenaScripts: arr<ScamScriptDef>(raw.arenaScripts).filter((x) => isObj(x) && typeof x.id === "string"),
    eval: isObj(raw.eval) && Array.isArray(raw.eval.cases) ? (raw.eval as unknown as EvalReport) : undefined,
    evalRuns: arr<EvalRun>(raw.evalRuns).filter((x) => isObj(x) && isObj(x.summary)),
    playbook: arr<PlaybookEntry>(raw.playbook).filter((x) => isObj(x) && typeof x.id === "string"),
    corrections: arr<Correction>(raw.corrections).filter((x) => isObj(x) && typeof x.id === "string"),
  };
}
