import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Target } from "@baitnet/shared";
import { safeTargetKey } from "./normalize.js";
import { rpcQuery } from "./rpc.js";

/** Data sources for the young-account and contract-code-changed signals. */
export interface AccountInfoProvider {
  createdAt(target: Target): Promise<Date | undefined>;
  codeChangedAt(target: Target): Promise<Date | undefined>;
}

export interface AccountMeta {
  chain: Target["chain"];
  address: string;
  createdAt?: string;
  /** Relative alternative to createdAt (keeps sample data valid whenever the demo runs). */
  ageDays?: number;
  codeChangedAt?: string;
  codeChangedHoursAgo?: number;
  note?: string;
}

/** Sample data (fixtures/account-meta.json) — used for EVM/Tron/BTC and for demo overrides. */
export class SampleAccountInfo implements AccountInfoProvider {
  private map = new Map<string, AccountMeta>();
  constructor(
    entries: AccountMeta[],
    private now: () => Date = () => new Date(),
  ) {
    for (const e of entries) this.map.set(safeTargetKey(e), e);
  }
  static fromFile(path: string, now?: () => Date): SampleAccountInfo {
    return new SampleAccountInfo(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as AccountMeta[]) : [], now);
  }
  get(t: Target): AccountMeta | undefined {
    return this.map.get(safeTargetKey(t));
  }
  async createdAt(t: Target) {
    const m = this.get(t);
    if (m?.createdAt) return new Date(m.createdAt);
    if (m?.ageDays !== undefined) return new Date(this.now().getTime() - m.ageDays * 86_400_000);
    return undefined;
  }
  async codeChangedAt(t: Target) {
    const m = this.get(t);
    if (m?.codeChangedAt) return new Date(m.codeChangedAt);
    if (m?.codeChangedHoursAgo !== undefined) return new Date(this.now().getTime() - m.codeChangedHoursAgo * 3_600_000);
    return undefined;
  }
}

interface CodeObs {
  hash: string;
  firstSeen: string;
  changedAt?: string;
}

/**
 * NEAR RPC: watches `view_account.code_hash`. A hash differing from the last
 * observation marks a code change at observation time. NEAR RPC has no account
 * creation time, so `createdAt` returns undefined (falls through to samples).
 */
export class NearRpcAccountInfo implements AccountInfoProvider {
  private obs: Record<string, CodeObs> = {};
  constructor(
    private rpcUrl: string,
    private opts: { storePath?: string; now?: () => Date } = {},
  ) {
    if (opts.storePath && existsSync(opts.storePath)) this.obs = JSON.parse(readFileSync(opts.storePath, "utf8"));
  }
  async createdAt(): Promise<Date | undefined> {
    return undefined;
  }
  async codeChangedAt(t: Target): Promise<Date | undefined> {
    if (t.chain !== "near") return undefined;
    let res: { code_hash: string };
    try {
      res = await rpcQuery<{ code_hash: string }>(this.rpcUrl, {
        request_type: "view_account",
        finality: "final",
        account_id: t.address.toLowerCase(),
      });
    } catch {
      return undefined; // unknown account → no signal
    }
    const key = safeTargetKey(t);
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const prev = this.obs[key];
    if (!prev) this.obs[key] = { hash: res.code_hash, firstSeen: now };
    else if (prev.hash !== res.code_hash) this.obs[key] = { hash: res.code_hash, firstSeen: prev.firstSeen, changedAt: now };
    this.persist();
    const c = this.obs[key]!.changedAt;
    return c ? new Date(c) : undefined;
  }
  private persist() {
    const p = this.opts.storePath;
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(this.obs, null, 2));
  }
}

/** First provider that knows wins. */
export class CompositeAccountInfo implements AccountInfoProvider {
  constructor(private providers: AccountInfoProvider[]) {}
  async createdAt(t: Target) {
    for (const p of this.providers) {
      const v = await p.createdAt(t);
      if (v) return v;
    }
    return undefined;
  }
  async codeChangedAt(t: Target) {
    for (const p of this.providers) {
      const v = await p.codeChangedAt(t);
      if (v) return v;
    }
    return undefined;
  }
}
