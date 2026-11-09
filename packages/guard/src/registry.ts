import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Ack,
  AckOutcome,
  AlertStatus,
  AlertView,
  Chain,
  Level,
  Responder,
} from "@baitnet/shared";
import { normalizeAddress } from "./normalize.js";

export interface ReportArgs {
  address: string;
  chain: Chain;
  evidenceHash: string;
  level: Level;
  category: string;
}

export interface TxResult<T = void> {
  value: T;
  txHash?: string;
  /** NEP-297 EVENT_JSON logs, parsed */
  events?: unknown[];
}

/**
 * Same surface as the AlertRegistry contract (docs §3 M3), camelCase on the TS side.
 * Write methods are bound to whichever account the client was built with.
 */
export interface RegistryClient {
  readonly kind: "chain" | "memory";
  readonly contractId: string;
  report(args: ReportArgs): Promise<TxResult<number>>;
  setStatus(alertId: number, status: AlertStatus, reasonHash?: string): Promise<TxResult>;
  registerResponder(name: string): Promise<TxResult>;
  ack(alertId: number, outcome: AckOutcome): Promise<TxResult>;
  check(chain: Chain, address: string): Promise<AlertView | null>;
  listAlerts(fromIndex?: number, limit?: number): Promise<AlertView[]>;
  getAlert(id: number): Promise<AlertView | null>;
  getAcks(alertId: number): Promise<Ack[]>;
  getResponder(accountId: string): Promise<Responder | null>;
  listResponders(fromIndex?: number, limit?: number): Promise<Responder[]>;
}

export const MAX_PAGE = 100;

// ------------------------------------------------------------------ JSON mapping

export interface RawAlertView {
  id: number;
  chain: Chain;
  address: string;
  level: Level;
  category: string;
  evidence_hash: string;
  evidence_hashes?: string[];
  status: AlertStatus;
  reporter: string;
  created_at: string;
  updated_at?: string;
  status_reason_hash?: string | null;
}

export function nsToIso(ns: string | number | bigint): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  return new Date(ms).toISOString();
}

export function fromRawAlert(r: RawAlertView, txHash?: string): AlertView {
  return {
    id: Number(r.id),
    chain: r.chain,
    address: r.address,
    level: r.level,
    category: r.category,
    evidenceHash: r.evidence_hash,
    status: r.status,
    reporter: r.reporter,
    createdAt: nsToIso(r.created_at),
    ...(r.updated_at ? { updatedAt: nsToIso(r.updated_at) } : {}),
    ...(r.evidence_hashes ? { evidenceHashes: r.evidence_hashes } : {}),
    ...(r.status_reason_hash !== undefined ? { statusReasonHash: r.status_reason_hash } : {}),
    ...(txHash ? { txHash } : {}),
  };
}

// ------------------------------------------------------------------ memory impl

interface MemAlert extends AlertView {
  evidenceHashes: string[];
}

interface MemState {
  alerts: MemAlert[];
  latest: Record<string, number>;
  acks: Record<number, Ack[]>;
  responders: Responder[];
  reporters: string[];
}

const SEVERITY: Record<Level, number> = { L1: 0, L2: 1, L3: 2 };

/**
 * In-memory registry with contract semantics. Optional `persistPath` makes it
 * file-backed so separate processes (agent CLI, server) share state in the
 * no-sandbox offline mode.
 */
export class MemoryRegistryClient implements RegistryClient {
  readonly kind = "memory" as const;
  readonly contractId: string;
  private state: MemState;
  private txCounter = 0;

  constructor(
    private opts: {
      caller?: string;
      contractId?: string;
      reporters?: string[];
      persistPath?: string;
      now?: () => Date;
    } = {},
  ) {
    this.contractId = opts.contractId ?? "registry.memory";
    this.state = { alerts: [], latest: {}, acks: {}, responders: [], reporters: opts.reporters ?? [] };
    this.load();
    if (opts.caller && opts.reporters === undefined && !this.state.reporters.includes(opts.caller)) {
      // default: the caller is whitelisted (convenient for tests/demo)
      this.state.reporters.push(opts.caller);
    }
  }

  /** Same backing state, different signer (e.g. a responder). */
  as(caller: string): MemoryRegistryClient {
    const c = new MemoryRegistryClient({ ...this.opts, caller, reporters: this.state.reporters });
    c.state = this.state;
    return c;
  }

  private get caller(): string {
    return this.opts.caller ?? "anonymous.memory";
  }
  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
  private load() {
    const p = this.opts.persistPath;
    if (p && existsSync(p)) {
      this.state = JSON.parse(readFileSync(p, "utf8")) as MemState;
    }
  }
  private save() {
    const p = this.opts.persistPath;
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(this.state, null, 2));
  }
  private reload() {
    if (this.opts.persistPath) this.load();
  }
  private fakeTx(): string {
    this.txCounter += 1;
    return `mem-tx-${Date.now().toString(36)}-${this.txCounter}`;
  }
  private pub(a: MemAlert): AlertView {
    return { ...a, evidenceHashes: [...a.evidenceHashes] };
  }

  async report(args: ReportArgs): Promise<TxResult<number>> {
    this.reload();
    if (!this.state.reporters.includes(this.caller)) throw new Error("ERR_NOT_REPORTER");
    const address = normalizeAddress(args.chain, args.address);
    const hash = args.evidenceHash.toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("ERR_BAD_HASH");
    const key = `${args.chain}:${address}`;
    const txHash = this.fakeTx();
    const existing = this.state.latest[key];
    if (existing !== undefined) {
      const a = this.state.alerts[existing]!;
      if (a.status === "Active") {
        if (!a.evidenceHashes.includes(hash)) a.evidenceHashes.push(hash);
        if (SEVERITY[args.level] < SEVERITY[a.level]) a.level = args.level;
        a.updatedAt = this.now().toISOString();
        this.save();
        return { value: a.id, txHash };
      }
    }
    const id = this.state.alerts.length;
    this.state.alerts.push({
      id,
      chain: args.chain,
      address,
      level: args.level,
      category: args.category,
      evidenceHash: hash,
      evidenceHashes: [hash],
      status: "Active",
      reporter: this.caller,
      createdAt: this.now().toISOString(),
      txHash,
    });
    this.state.latest[key] = id;
    this.save();
    return { value: id, txHash };
  }

  async setStatus(alertId: number, status: AlertStatus): Promise<TxResult> {
    this.reload();
    const a = this.state.alerts[alertId];
    if (!a) throw new Error("ERR_NO_ALERT");
    if (a.reporter !== this.caller && !this.state.reporters.includes(this.caller)) throw new Error("ERR_NOT_ALLOWED");
    if (a.status === status) throw new Error("ERR_SAME_STATUS");
    a.status = status;
    a.updatedAt = this.now().toISOString();
    this.save();
    return { value: undefined, txHash: this.fakeTx() };
  }

  async registerResponder(name: string): Promise<TxResult> {
    this.reload();
    const existing = this.state.responders.find((r) => r.accountId === this.caller);
    if (existing) existing.name = name;
    else this.state.responders.push({ accountId: this.caller, name, registeredAt: this.now().toISOString() });
    this.save();
    return { value: undefined, txHash: this.fakeTx() };
  }

  async ack(alertId: number, outcome: AckOutcome): Promise<TxResult> {
    this.reload();
    if (!this.state.responders.some((r) => r.accountId === this.caller)) throw new Error("ERR_NOT_RESPONDER");
    if (!this.state.alerts[alertId]) throw new Error("ERR_NO_ALERT");
    const list = (this.state.acks[alertId] ??= []);
    const at = this.now().toISOString();
    const ex = list.find((a) => a.responder === this.caller);
    if (ex) Object.assign(ex, { outcome, at });
    else list.push({ alertId, responder: this.caller, outcome, at });
    this.save();
    return { value: undefined, txHash: this.fakeTx() };
  }

  async check(chain: Chain, address: string): Promise<AlertView | null> {
    this.reload();
    let addr: string;
    try {
      addr = normalizeAddress(chain, address);
    } catch {
      return null;
    }
    const id = this.state.latest[`${chain}:${addr}`];
    if (id === undefined) return null;
    const a = this.state.alerts[id]!;
    if (a.status === "Revoked" || a.level === "L3") return null;
    return this.pub(a);
  }

  async listAlerts(fromIndex = 0, limit = 50): Promise<AlertView[]> {
    this.reload();
    return this.state.alerts.slice(fromIndex, fromIndex + Math.min(limit, MAX_PAGE)).map((a) => this.pub(a));
  }

  async getAlert(id: number): Promise<AlertView | null> {
    this.reload();
    const a = this.state.alerts[id];
    return a ? this.pub(a) : null;
  }

  async getAcks(alertId: number): Promise<Ack[]> {
    this.reload();
    return [...(this.state.acks[alertId] ?? [])];
  }

  async getResponder(accountId: string): Promise<Responder | null> {
    this.reload();
    return this.state.responders.find((r) => r.accountId === accountId) ?? null;
  }

  async listResponders(fromIndex = 0, limit = 50): Promise<Responder[]> {
    this.reload();
    return this.state.responders.slice(fromIndex, fromIndex + Math.min(limit, MAX_PAGE));
  }
}
