import { randomUUID } from "node:crypto";
import { parseNearAmount } from "near-api-js";
import type { GuardEvent, Verdict } from "@baitnet/shared";
import { NearCaller, type Guard, type NearKey } from "@baitnet/guard";

export interface PaymentIntent {
  to: string;
  amount: string; // human units
  asset: string; // what the text asked for (NEAR/USDC…); the vault pays NEAR
  source: string; // line of the task text that produced it
  injected: boolean;
}

/**
 * Simulated *compromised* planner: it follows every payment instruction found in
 * the task text, including ones hidden in scraped attachments — exactly what a
 * prompt-injected LLM agent does. Deterministic so the demo is reproducible.
 */
export function planPayments(task: string): PaymentIntent[] {
  const out: PaymentIntent[] = [];
  const re = /\b(pay|transfer|send)\s+(\d+(?:\.\d+)?)\s*(NEAR|USDC|USDT)\b[^\n]*?\bto\s+([a-z0-9][a-z0-9._-]*\.(?:near|testnet))/gi;
  const attachStart = task.search(/-{3,}\s*attached/i);
  for (const m of task.matchAll(re)) {
    const idx = m.index ?? 0;
    const lineStart = task.lastIndexOf("\n", idx) + 1;
    const lineEnd = task.indexOf("\n", idx);
    out.push({
      to: m[4]!.toLowerCase(),
      amount: m[2]!,
      asset: m[3]!.toUpperCase(),
      source: task.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim(),
      injected: attachStart >= 0 && idx > attachStart,
    });
  }
  return out;
}

export interface SignResult {
  txHash?: string;
  failure?: string;
  dryRun?: boolean;
  /** NEP-297 events from the tx receipts (pay_requested / pay_blocked / paid …) */
  events?: unknown[];
}

/** Signs vault.pay with the agent's function-call key (can ONLY call vault.pay). */
export type PaySigner = (p: PaymentIntent) => Promise<SignResult>;

export function vaultSigner(rpcUrl: string, vaultContract: string, agentKey: NearKey): PaySigner {
  const caller = new NearCaller(rpcUrl, agentKey);
  return async (p) => {
    const amount = parseNearAmount(p.amount as `${number}`);
    if (!amount) throw new Error(`bad amount ${p.amount}`);
    try {
      const out = await caller.call(vaultContract, "pay", { to: p.to, amount }, { gas: 100_000_000_000_000n });
      return { txHash: out.txHash, events: out.events, ...(out.failure ? { failure: out.failure } : {}) };
    } catch (e) {
      return { failure: (e as Error).message, txHash: (e as { txHash?: string }).txHash };
    }
  };
}

export const dryRunSigner: PaySigner = async () => ({ dryRun: true });

export type HumanPrompt = (q: string, v: Verdict) => Promise<"approve" | "reject">;
/** Demo: the human always says no (but the question is logged). */
export const autoRejectHuman: HumanPrompt = async () => "reject";

export interface GuardedSignDeps {
  guard: Guard;
  signer: PaySigner;
  askHuman?: HumanPrompt;
  emit?: (e: GuardEvent) => void;
  now?: () => Date;
}

/**
 * M5 wrapper: every payment goes through the guard first.
 *   block → refuse, never reaches the key
 *   warn  → ask a human (demo auto-rejects), logged as asked-human
 *   allow → sign vault.pay with the function-call key
 */
export async function guardedSign(p: PaymentIntent, deps: GuardedSignDeps): Promise<GuardEvent> {
  const now = deps.now ?? (() => new Date());
  const log: string[] = [];
  log.push(`[agent] intent: pay ${p.amount} ${p.asset} → ${p.to}${p.injected ? "  (instruction came from scraped attachment!)" : ""}`);
  log.push(`[agent] source: "${p.source.slice(0, 140)}"`);
  const verdict = await deps.guard.check({ chain: "near", address: p.to });
  log.push(`[guard] verdict=${verdict.kind.toUpperCase()} ${verdict.reasons.map((r) => `${r.signal}(${r.weight}): ${r.detail}`).join("; ") || "no risk signals"}`);
  let action: GuardEvent["action"];
  if (verdict.kind === "block") {
    action = "refused";
    log.push(`[wallet] REFUSED to sign: ${p.to} is on the BaitNet registry${verdict.alert ? ` (alert #${verdict.alert.id})` : ""}. Key never touched.`);
  } else if (verdict.kind === "warn") {
    const q = `Pay ${p.amount} ${p.asset} to ${p.to}? Guard says WARN: ${verdict.reasons.map((r) => r.detail).join("; ")}`;
    log.push(`[human?] ${q}`);
    const ans = await (deps.askHuman ?? autoRejectHuman)(q, verdict);
    log.push(`[human] answered: ${ans}${deps.askHuman ? "" : " (demo auto-reject)"}`);
    if (ans === "approve") {
      const r = await deps.signer(p);
      action = r.failure ? "refused" : "signed";
      log.push(...signLog(r));
    } else action = "asked-human";
  } else {
    const r = await deps.signer(p);
    action = r.failure ? "refused" : "signed";
    log.push(...signLog(r));
    if (!r.failure) await deps.guard.recordInteraction({ chain: "near", address: p.to });
  }
  const ev: GuardEvent = { id: randomUUID(), source: "agent-wallet", verdict, action, log, at: now().toISOString() };
  deps.emit?.(ev);
  return ev;
}

export function signLog(r: SignResult): string[] {
  if (r.dryRun) return ["[wallet] (dry run: no vault configured) would call vault.pay with the function-call key"];
  const evs = (r.events ?? []).map((e: any) => `[vault] event ${e?.event ?? "?"} ${JSON.stringify(e?.data?.[0] ?? {})}`);
  if (r.failure) return [`[wallet] vault.pay FAILED on chain: ${r.failure.slice(0, 200)}`, ...evs, ...(r.txHash ? [`[wallet] tx ${r.txHash}`] : [])];
  return [`[wallet] signed vault.pay with function-call key (vault:pay only) → tx ${r.txHash}`, ...evs];
}
