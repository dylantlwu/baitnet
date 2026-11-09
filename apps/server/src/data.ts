import { existsSync } from "node:fs";
import { loadScripts, readLatestReport, readSessions, training, type ArenaManager } from "@baitnet/arena";
import type { Ack, AlertView, AttestationResult, DemoSnapshot, EvidenceResponse, FlowEdge, Responder } from "@baitnet/shared";
import {
  CompositeAccountInfo,
  Guard,
  MemoryRegistryClient,
  NearRpcAccountInfo,
  SampleAccountInfo,
  type AccountInfoProvider,
  type RegistryClient,
} from "@baitnet/guard";
import {
  RuntimeMissingError,
  dataPath,
  fixturePath,
  loadEnv,
  openEvidence,
  readAckReceipts,
  readConversations,
  readEvents,
  readFlows,
  readReports,
  type Env,
} from "@baitnet/agent";

/**
 * Data access for the HTTP server. Re-resolves the environment when
 * data/runtime.json appears later (ops writes it after deploying), and falls
 * back to the file-backed memory registry when there is no chain.
 */
export class DataSource {
  private env?: Env;
  private envKey = "";
  private guard?: Guard;
  private accountInfo?: AccountInfoProvider;
  warning?: string;

  constructor(private log: (s: string) => void = () => {}) {}

  getEnv(): Env {
    const key = `${process.env.BAITNET_REGISTRY ?? ""}|${existsSync(dataPath("runtime.json"))}`;
    if (this.env && key === this.envKey) return this.env;
    this.envKey = key;
    this.guard?.stop();
    this.guard = undefined;
    try {
      this.env = loadEnv();
      this.warning = undefined;
    } catch (e) {
      if (!(e instanceof RuntimeMissingError)) throw e;
      const reg = new MemoryRegistryClient({ caller: "reporter.memory", persistPath: dataPath("memory-registry.json"), contractId: "registry.memory" });
      this.env = { mode: "memory", network: "memory", registry: reg, registryAs: (a) => reg.as(a.accountId) };
      this.warning = "data/runtime.json not found — serving the local memory registry (data/memory-registry.json)";
      this.log(`[server] ${this.warning}`);
    }
    return this.env;
  }

  get registry(): RegistryClient {
    return this.getEnv().registry;
  }

  /** Long-lived guard for GET /check: synced in the background, answers from the local cache. */
  async getGuard(): Promise<Guard> {
    const env = this.getEnv();
    if (!this.guard) {
      const samples = SampleAccountInfo.fromFile(fixturePath("account-meta.json"));
      this.accountInfo = env.runtime ? new CompositeAccountInfo([samples, new NearRpcAccountInfo(env.runtime.rpcUrl, { storePath: dataPath("code-hashes.json") })]) : samples;
      this.guard = new Guard({ registry: env.registry, accountInfo: this.accountInfo, syncIntervalMs: 3000, fullResyncEvery: 5, log: this.log });
      await this.guard.sync();
      this.guard.start();
    }
    return this.guard;
  }

  stop() {
    this.guard?.stop();
  }

  /** All alerts, enriched with txHash + conversationId from the local report index. */
  async alerts(): Promise<AlertView[]> {
    const out: AlertView[] = [];
    for (let from = 0; ; ) {
      const page = await this.registry.listAlerts(from, 100);
      out.push(...page);
      from += page.length;
      if (page.length < 100) break;
    }
    const reports = readReports();
    return out.map((a) => {
      const recs = reports.filter((r) => r.alertId === a.id);
      const first = recs.find((r) => r.evidenceHash === a.evidenceHash) ?? recs[0];
      return {
        ...a,
        ...(first?.conversationId ? { conversationId: first.conversationId } : {}),
        ...(a.txHash ? {} : first?.txHash ? { txHash: first.txHash } : {}),
      };
    });
  }

  async evidence(alertId: number): Promise<EvidenceResponse | null> {
    const a = await this.registry.getAlert(alertId);
    if (!a) return null;
    const ev = openEvidence(a.evidenceHash);
    if (!ev) return null;
    return { alertId, plaintext: ev.plaintext };
  }

  async evidenceMap(alerts: AlertView[]): Promise<Record<number, string>> {
    const m: Record<number, string> = {};
    for (const a of alerts) {
      try {
        const ev = openEvidence(a.evidenceHash);
        if (ev?.hashMatches) m[a.id] = ev.plaintext;
      } catch {
        /* key mismatch or corrupt file: skip */
      }
    }
    return m;
  }

  flows(alertId: number): FlowEdge[] {
    return readFlows()[alertId] ?? [];
  }

  async responders(): Promise<Responder[]> {
    return this.registry.listResponders(0, 100);
  }

  async acks(alerts: AlertView[]): Promise<Ack[]> {
    const receipts = readAckReceipts();
    const out: Ack[] = [];
    for (const a of alerts) {
      for (const ack of await this.registry.getAcks(a.id)) {
        const r = receipts.find((x) => x.alertId === ack.alertId && x.responder === ack.responder);
        out.push(r ? { ...ack, receivedAt: r.receivedAt } : ack);
      }
    }
    return out;
  }

  async snapshot(attestation?: AttestationResult, arena?: ArenaManager): Promise<DemoSnapshot> {
    const env = this.getEnv();
    const alerts = await this.alerts();
    const t = await training();
    const safe = async <T,>(fn: (() => T | Promise<T>) | undefined): Promise<T | undefined> => {
      try {
        return fn ? await fn() : undefined;
      } catch (e) {
        this.log(`[snapshot] training export failed: ${(e as Error).message}`);
        return undefined;
      }
    };
    const evalReport = readLatestReport();
    const [evalRuns, playbook, corrections] = await Promise.all([safe(t.listEvalRuns), safe(t.listPlaybook), safe(t.listCorrections)]);
    return {
      generatedAt: new Date().toISOString(),
      network: env.network === "testnet" ? "testnet" : "sandbox",
      registryContract: env.registry.contractId,
      alerts,
      conversations: readConversations(),
      events: readEvents(),
      flows: readFlows(),
      responders: await this.responders(),
      acks: await this.acks(alerts),
      evidence: await this.evidenceMap(alerts),
      ...(attestation ? { attestation } : {}),
      arenaScripts: (arena ? await arena.scripts() : await loadScripts()).map(({ id, type, lang, title }) => ({ id, type, lang, title })),
      arenaSessions: arena ? arena.list() : readSessions(),
      ...(evalReport ? { eval: evalReport } : {}),
      ...(evalRuns ? { evalRuns } : {}),
      ...(playbook ? { playbook } : {}),
      ...(corrections ? { corrections } : {}),
    };
  }
}
