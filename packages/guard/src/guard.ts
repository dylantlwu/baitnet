import { randomUUID } from "node:crypto";
import type { AlertView, Target, Verdict, VerdictKind, VerdictReason } from "@baitnet/shared";
import { MAX_PAGE, type RegistryClient } from "./registry.js";
import { safeTargetKey } from "./normalize.js";
import type { AccountInfoProvider } from "./account-info.js";

export const DEFAULT_WEIGHTS: Record<VerdictReason["signal"], number> = {
  "registry-l1": 1,
  "registry-l2-or-disputed": 0.6,
  "young-account": 0.4,
  "contract-code-changed": 0.5,
  "no-prior-interaction": 0.2,
};

export interface InteractionHistory {
  has(key: string): boolean | Promise<boolean>;
  add(key: string): void | Promise<void>;
}

export class MemoryHistory implements InteractionHistory {
  private set = new Set<string>();
  constructor(initial: Iterable<string> = []) {
    for (const k of initial) this.set.add(k);
  }
  has(k: string) {
    return this.set.has(k);
  }
  add(k: string) {
    this.set.add(k);
  }
}

export interface GuardOptions {
  registry: RegistryClient;
  accountInfo?: AccountInfoProvider;
  /** Enables the "no-prior-interaction" signal (per-agent local history). */
  history?: InteractionHistory;
  /** Sum of non-block weights at or above this → warn. Default 0.3 (so the low-weight history signal alone stays allow). */
  warnThreshold?: number;
  weights?: Partial<typeof DEFAULT_WEIGHTS>;
  youngAccountDays?: number;
  codeChangeWindowHours?: number;
  syncIntervalMs?: number;
  /** Every N incremental syncs, re-read all alerts to pick up status changes (list_alerts is index-ordered). */
  fullResyncEvery?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * M4 guard. Keeps a local copy of the registry (incremental sync via
 * `list_alerts` + cursor) and evaluates targets entirely locally: the address
 * being checked is never sent anywhere (privacy, docs §3 M4).
 */
export class Guard {
  private cache = new Map<string, AlertView>();
  private cursor = 0;
  private syncCount = 0;
  private synced = false;
  private timer?: ReturnType<typeof setInterval>;
  private weights: typeof DEFAULT_WEIGHTS;
  readonly id = randomUUID();

  constructor(private opts: GuardOptions) {
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  }

  get cacheSize() {
    return this.cache.size;
  }
  get syncCursor() {
    return this.cursor;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Pull alerts newer than the cursor (and periodically everything, for status changes). */
  async sync(): Promise<{ fetched: number; cursor: number }> {
    const full = this.synced && (this.opts.fullResyncEvery ?? 10) > 0 && this.syncCount % (this.opts.fullResyncEvery ?? 10) === 0 && this.syncCount > 0;
    let from = full ? 0 : this.cursor;
    let fetched = 0;
    for (;;) {
      const page = await this.opts.registry.listAlerts(from, MAX_PAGE);
      for (const a of page) this.ingest(a);
      fetched += page.length;
      from += page.length;
      if (page.length < MAX_PAGE) break;
    }
    this.cursor = Math.max(this.cursor, from);
    this.syncCount += 1;
    this.synced = true;
    this.opts.log?.(`[guard] sync ${full ? "full" : "incremental"}: +${fetched} alerts, cursor=${this.cursor}, cached=${this.cache.size}`);
    return { fetched, cursor: this.cursor };
  }

  /** Apply one alert view (also used for push-style updates, e.g. from an indexer). */
  ingest(a: AlertView) {
    const key = safeTargetKey(a);
    const cur = this.cache.get(key);
    if (cur && cur.id > a.id) return; // keep the latest alert for the target, like latest_by_target
    if (a.status === "Revoked" || a.level === "L3") {
      if (!cur || cur.id === a.id) this.cache.delete(key);
      return;
    }
    this.cache.set(key, a);
  }

  start(intervalMs = this.opts.syncIntervalMs ?? 5000) {
    this.stop();
    this.timer = setInterval(() => {
      this.sync().catch((e) => this.opts.log?.(`[guard] sync failed: ${(e as Error).message}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Look up the local cache only. */
  lookup(target: Target): AlertView | undefined {
    return this.cache.get(safeTargetKey(target));
  }

  async check(target: Target): Promise<Verdict> {
    if (!this.synced) await this.sync();
    const reasons: VerdictReason[] = [];
    const w = this.weights;
    const alert = this.lookup(target);
    if (alert) {
      if (alert.level === "L1" && alert.status === "Active") {
        reasons.push({
          signal: "registry-l1",
          detail: `alert #${alert.id} (${alert.category}) Active L1, evidence ${alert.evidenceHash.slice(0, 12)}…`,
          weight: w["registry-l1"],
        });
      } else {
        reasons.push({
          signal: "registry-l2-or-disputed",
          detail: `alert #${alert.id} ${alert.level} ${alert.status}`,
          weight: w["registry-l2-or-disputed"],
        });
      }
    }

    const info = this.opts.accountInfo;
    if (info) {
      const now = this.now();
      try {
        const created = await info.createdAt(target);
        if (created) {
          const days = (now.getTime() - created.getTime()) / 86_400_000;
          if (days < (this.opts.youngAccountDays ?? 7)) {
            reasons.push({ signal: "young-account", detail: `account created ${days.toFixed(1)} days ago`, weight: w["young-account"] });
          }
        }
        const changed = await info.codeChangedAt(target);
        if (changed) {
          const hours = (now.getTime() - changed.getTime()) / 3_600_000;
          if (hours >= 0 && hours < (this.opts.codeChangeWindowHours ?? 24)) {
            reasons.push({
              signal: "contract-code-changed",
              detail: `contract code hash changed ${hours.toFixed(1)}h ago`,
              weight: w["contract-code-changed"],
            });
          }
        }
      } catch (e) {
        this.opts.log?.(`[guard] account info unavailable: ${(e as Error).message}`);
      }
    }

    if (this.opts.history && !(await this.opts.history.has(safeTargetKey(target)))) {
      reasons.push({ signal: "no-prior-interaction", detail: "this agent has never paid this address", weight: w["no-prior-interaction"] });
    }

    return {
      kind: decide(reasons, this.opts.warnThreshold ?? 0.3),
      target: { chain: target.chain, address: target.address },
      reasons,
      ...(alert ? { alert } : {}),
      checkedAt: this.now().toISOString(),
    };
  }

  /** Call after a payment was actually signed. */
  async recordInteraction(target: Target) {
    await this.opts.history?.add(safeTargetKey(target));
  }
}

export function decide(reasons: VerdictReason[], warnThreshold: number): VerdictKind {
  if (reasons.some((r) => r.signal === "registry-l1")) return "block";
  if (reasons.some((r) => r.signal === "registry-l2-or-disputed")) return "warn";
  const score = reasons.reduce((s, r) => s + r.weight, 0);
  return score >= warnThreshold ? "warn" : "allow";
}
