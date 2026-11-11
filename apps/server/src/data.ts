import { existsSync } from "node:fs";
import { loadScripts, readLatestReport, readSessions, training, withoutHiddenMinds, type ArenaManager } from "@baitnet/arena";
import type { Ack, AlertView, AttestationResult, DemoSnapshot, EvidenceResponse, FlowEdge, Responder } from "@baitnet/shared";
import {
  CachedRegistryClient,
  CompositeAccountInfo,
  DEFAULT_REGISTRY_CACHE_MS,
  Guard,
  MAX_PAGE,
  SwrCache,
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
 * Chain registries are read through a stale-while-revalidate cache: every dashboard tab polls the
 * public endpoints every 10 s, and a public testnet RPC takes 0.5–4 s per view call (and answers
 * bursts with HTTP 429). Reads return the last value at once; a background timer reloads the keys
 * that are being read every `refreshMs` (BAITNET_REGISTRY_CACHE_MS, default 15 s; 0 disables).
 * Writes made through this server (B2 review, IM, …) invalidate it: the next read waits for data
 * loaded after the write. Writes from other processes (the agent CLI) show up within one interval.
 */
export function withReadCache(
  env: Env,
  refreshMs = Number(process.env.BAITNET_REGISTRY_CACHE_MS ?? DEFAULT_REGISTRY_CACHE_MS),
  log?: (s: string) => void,
): Env {
  if (env.mode !== "chain" || !(refreshMs > 0)) return env;
  const cached = new CachedRegistryClient(env.registry, new SwrCache({ refreshMs, log }).start());
  return { ...env, registry: cached, registryAs: (a) => cached.share(env.registryAs(a)) };
}

/** Like Promise.all(items.map(fn)) with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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
    this.stopCache();
    try {
      this.env = withReadCache(loadEnv(), undefined, this.log);
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

  /** The SWR cache behind the registry (chain mode only). */
  get cache(): SwrCache | undefined {
    const reg = this.env?.registry;
    return reg instanceof CachedRegistryClient && reg.cache instanceof SwrCache ? reg.cache : undefined;
  }

  private stopCache() {
    this.cache?.stop();
  }

  /**
   * Load what the dashboard reads (alerts, responders, acks) into the cache at startup, so the
   * first visitor does not wait for the RPC. Failures only log; reads retry on demand.
   */
  async warm(): Promise<void> {
    const env = this.getEnv();
    if (env.mode !== "chain") return;
    const t0 = Date.now();
    try {
      const alerts = await this.alerts();
      await Promise.all([this.responders(), this.acks(alerts)]);
      this.log(`[server] registry cache warm (${alerts.length} alerts) in ${Date.now() - t0} ms`);
    } catch (e) {
      this.log(`[server] registry cache warm-up failed: ${(e as Error).message}`);
    }
  }

  stop() {
    this.guard?.stop();
    this.stopCache();
  }

  /** All alerts, enriched with txHash + conversationId from the local report index. */
  async alerts(): Promise<AlertView[]> {
    const out: AlertView[] = [];
    // one list_alerts call per 100 alerts; the next page is only read when this one came back full
    for (let from = 0; ; ) {
      const page = await this.registry.listAlerts(from, MAX_PAGE);
      out.push(...page);
      from += page.length;
      if (page.length < MAX_PAGE) break;
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

  /**
   * The contract only has get_acks(alert_id), so this is one view call per alert: run them
   * a few at a time (not one after another) — each is cached and refreshed in the background.
   */
  async acks(alerts: AlertView[]): Promise<Ack[]> {
    const receipts = readAckReceipts();
    const lists = await mapLimit(alerts, 4, (a) => this.registry.getAcks(a.id));
    return lists.flat().map((ack) => {
      const r = receipts.find((x) => x.alertId === ack.alertId && x.responder === ack.responder);
      return r ? { ...ack, receivedAt: r.receivedAt } : ack;
    });
  }

  async snapshot(attestation?: AttestationResult, arena?: ArenaManager): Promise<DemoSnapshot> {
    const env = this.getEnv();
    const alerts = await this.alerts();
    const [responders, acks] = await Promise.all([this.responders(), this.acks(alerts)]);
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
      responders,
      acks,
      evidence: await this.evidenceMap(alerts),
      ...(attestation ? { attestation } : {}),
      arenaScripts: (arena ? await arena.scripts() : await loadScripts()).map(({ id, type, lang, title }) => ({ id, type, lang, title })),
      // public static snapshot: the decoy's persona / mind are team-only (D32)
      arenaSessions: (arena ? arena.list() : readSessions()).map(withoutHiddenMinds),
      ...(evalReport ? { eval: evalReport } : {}),
      ...(evalRuns ? { evalRuns } : {}),
      ...(playbook ? { playbook } : {}),
      ...(corrections ? { corrections } : {}),
    };
  }
}
