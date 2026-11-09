import { Account, JsonRpcProvider, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import type { Ack, AckOutcome, AlertStatus, AlertView, Chain, Responder } from "@baitnet/shared";
import { fromRawAlert, nsToIso, type RawAlertView, type RegistryClient, type ReportArgs, type TxResult } from "./registry.js";
import { viewFunction } from "./rpc.js";

export interface NearKey {
  accountId: string;
  privateKey: string;
}

export const DEFAULT_GAS = 30_000_000_000_000n; // 30 Tgas

/** Result of a change call: parsed return value, tx hash, NEP-297 events, failure if any. */
export interface CallOutcome<T = unknown> {
  value: T | undefined;
  txHash: string;
  logs: string[];
  events: unknown[];
  failure?: string;
}

/** Thin signer wrapper around near-api-js v7 `Account.callFunctionRaw`. */
export class NearCaller {
  readonly account: Account;
  constructor(
    readonly rpcUrl: string,
    readonly key: NearKey,
  ) {
    const provider = new JsonRpcProvider({ url: rpcUrl });
    const signer = KeyPairSigner.fromSecretKey(key.privateKey as KeyPairString);
    this.account = new Account(key.accountId, provider, signer);
  }

  async call<T = unknown>(contractId: string, methodName: string, args: Record<string, unknown>, opts: { deposit?: bigint; gas?: bigint } = {}): Promise<CallOutcome<T>> {
    let raw: any;
    try {
      // throwOnFailure:false keeps receipts/logs of failed txs (e.g. vault pay_blocked events)
      raw = await this.account.signAndSendTransaction({
        receiverId: contractId,
        actions: [actions.functionCall(methodName, args, opts.gas ?? DEFAULT_GAS, opts.deposit ?? 0n)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      } as any);
    } catch (e: any) {
      // near-api-js throws typed errors for failed txs; surface a readable message
      const msg = e?.message ?? String(e);
      const err = new Error(`${methodName} failed: ${msg}`) as Error & { txHash?: string };
      err.txHash = e?.context?.transactionHash ?? e?.transaction_outcome?.id;
      throw err;
    }
    return parseOutcome<T>(raw);
  }
}

export function parseOutcome<T>(raw: any): CallOutcome<T> {
  const txHash: string = raw?.transaction?.hash ?? raw?.transaction_outcome?.id ?? "";
  const logs: string[] = [
    ...(raw?.transaction_outcome?.outcome?.logs ?? []),
    ...((raw?.receipts_outcome ?? []) as any[]).flatMap((r) => r?.outcome?.logs ?? []),
  ];
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length));
      } catch {
        return l;
      }
    });
  const status = raw?.status ?? {};
  let value: T | undefined;
  let failure: string | undefined;
  if (status.Failure) failure = JSON.stringify(status.Failure);
  else {
    // receipts may fail even if top-level is fine (cross-contract)
    const failed = ((raw?.receipts_outcome ?? []) as any[]).find((r) => r?.outcome?.status?.Failure);
    if (failed) failure = JSON.stringify(failed.outcome.status.Failure);
  }
  if (typeof status.SuccessValue === "string" && status.SuccessValue.length) {
    const text = Buffer.from(status.SuccessValue, "base64").toString("utf8");
    try {
      value = JSON.parse(text) as T;
    } catch {
      value = text as unknown as T;
    }
  }
  return { value, txHash, logs, events, ...(failure ? { failure } : {}) };
}

/**
 * AlertRegistry on a real NEAR network (sandbox/testnet). Views go through raw
 * JSON-RPC; change calls need `signer`.
 */
export class ChainRegistryClient implements RegistryClient {
  readonly kind = "chain" as const;
  private caller?: NearCaller;

  constructor(
    readonly rpcUrl: string,
    readonly contractId: string,
    signer?: NearKey,
  ) {
    if (signer) this.caller = new NearCaller(rpcUrl, signer);
  }

  as(signer: NearKey): ChainRegistryClient {
    return new ChainRegistryClient(this.rpcUrl, this.contractId, signer);
  }

  private async change<T>(method: string, args: Record<string, unknown>, deposit?: bigint): Promise<TxResult<T>> {
    if (!this.caller) throw new Error(`ChainRegistryClient: ${method} needs a signer key`);
    const out = await this.caller.call<T>(this.contractId, method, args, { deposit });
    if (out.failure) throw Object.assign(new Error(`${method} failed: ${out.failure}`), { txHash: out.txHash });
    return { value: out.value as T, txHash: out.txHash, events: out.events };
  }

  async report(a: ReportArgs): Promise<TxResult<number>> {
    const r = await this.change<number>("report", {
      address: a.address,
      chain: a.chain,
      evidence_hash: a.evidenceHash,
      level: a.level,
      category: a.category,
    });
    return { ...r, value: Number(r.value) };
  }

  setStatus(alertId: number, status: AlertStatus, reasonHash?: string) {
    return this.change<void>("set_status", { alert_id: alertId, status, reason_hash: reasonHash ?? null });
  }

  registerResponder(name: string) {
    return this.change<void>("register_responder", { name }, 10_000_000_000_000_000_000_000n); // 0.01 NEAR, excess refunded
  }

  ack(alertId: number, outcome: AckOutcome) {
    return this.change<void>("ack", { alert_id: alertId, outcome });
  }

  private view<T>(method: string, args: Record<string, unknown> = {}) {
    return viewFunction<T>(this.rpcUrl, this.contractId, method, args);
  }

  async check(chain: Chain, address: string): Promise<AlertView | null> {
    const r = await this.view<RawAlertView | null>("check", { chain, address });
    return r ? fromRawAlert(r) : null;
  }

  async listAlerts(fromIndex = 0, limit = 50): Promise<AlertView[]> {
    const r = await this.view<RawAlertView[]>("list_alerts", { from_index: fromIndex, limit });
    return (r ?? []).map((x) => fromRawAlert(x));
  }

  async getAlert(id: number): Promise<AlertView | null> {
    const r = await this.view<RawAlertView | null>("get_alert", { id });
    return r ? fromRawAlert(r) : null;
  }

  async getAcks(alertId: number): Promise<Ack[]> {
    const r = await this.view<{ alert_id: number; responder: string; outcome: AckOutcome; at: string }[]>("get_acks", { alert_id: alertId });
    return (r ?? []).map((a) => ({ alertId: Number(a.alert_id), responder: a.responder, outcome: a.outcome, at: nsToIso(a.at) }));
  }

  async getResponder(accountId: string): Promise<Responder | null> {
    const r = await this.view<{ account_id: string; name: string; registered_at: string } | null>("get_responder", { account_id: accountId });
    return r ? { accountId: r.account_id, name: r.name, registeredAt: nsToIso(r.registered_at) } : null;
  }

  async listResponders(fromIndex = 0, limit = 50): Promise<Responder[]> {
    const r = await this.view<{ account_id: string; name: string; registered_at: string }[]>("list_responders", { from_index: fromIndex, limit });
    return (r ?? []).map((x) => ({ accountId: x.account_id, name: x.name, registeredAt: nsToIso(x.registered_at) }));
  }
}
