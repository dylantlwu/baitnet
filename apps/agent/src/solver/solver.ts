import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Chain, GuardEvent, Verdict, VerdictKind } from "@baitnet/shared";
import type { Guard } from "@baitnet/guard";
import { fixturePath } from "../paths.js";
import { detectChain } from "../extract/extract.js";

/** Body of 1Click POST /v0/quote (subset we use). */
export interface OneClickQuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  deadline: string;
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface IncomingQuote {
  quoteId: string;
  receivedAt: string;
  depositAddress: string;
  request: OneClickQuoteRequest;
}

export function loadQuoteRequests(path = fixturePath("intents", "quote-requests.json")): IncomingQuote[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { requests: IncomingQuote[] }).requests;
}

/** Chain of an Intents asset id, e.g. nep141:tron-….omft.near → tron. */
export function chainOfAsset(assetId: string): Chain {
  const a = assetId.toLowerCase();
  if (/^nep141:tron-/.test(a)) return "tron";
  if (/^nep141:btc\./.test(a)) return "btc";
  if (/^nep141:(eth|arb|base|bsc|pol|op|avax|gnosis|bera)-/.test(a)) return "evm";
  return "near";
}

/** Chain for an address in a quote: prefer the address format, else the asset's chain. */
export function chainForAddress(addr: string, assetId: string, type: string): Chain {
  if (type === "INTENTS") return "near";
  return detectChain(addr) ?? chainOfAsset(assetId);
}

const RANK: Record<VerdictKind, number> = { allow: 0, warn: 1, block: 2 };

export interface QuoteDecision {
  quoteId: string;
  quoted: boolean;
  event: GuardEvent;
  verdicts: { field: "recipient" | "refundTo"; verdict: Verdict }[];
}

/**
 * M6 simulated market maker: before quoting, check `recipient` and `refundTo`
 * with the guard (local cache; addresses are not sent anywhere).
 *   block → refuse to quote;  warn → quote, flagged for manual review;  allow → quote.
 */
export async function handleQuote(q: IncomingQuote, guard: Guard, opts: { emit?: (e: GuardEvent) => void; now?: () => Date } = {}): Promise<QuoteDecision> {
  const r = q.request;
  const log: string[] = [`[solver] quote ${q.quoteId}: ${r.amount} ${r.originAsset} → ${r.destinationAsset} (deposit ${q.depositAddress.slice(0, 12)}…)`];
  const verdicts: QuoteDecision["verdicts"] = [];
  for (const field of ["recipient", "refundTo"] as const) {
    const addr = r[field];
    const chain = field === "recipient" ? chainForAddress(addr, r.destinationAsset, r.recipientType) : chainForAddress(addr, r.originAsset, r.refundType);
    const v = await guard.check({ chain, address: addr });
    verdicts.push({ field, verdict: v });
    log.push(`[guard] ${field}=${chain}:${addr} → ${v.kind.toUpperCase()}${v.reasons.length ? " · " + v.reasons.map((x) => x.detail).join("; ") : ""}`);
  }
  const worst = verdicts.reduce((a, b) => (RANK[b.verdict.kind] > RANK[a.verdict.kind] ? b : a));
  let action: GuardEvent["action"];
  if (worst.verdict.kind === "block") {
    action = "quote-refused";
    log.push(`[solver] REFUSED to quote: ${worst.field} is a flagged scam address${worst.verdict.alert ? ` (alert #${worst.verdict.alert.id})` : ""}`);
  } else {
    action = "quoted";
    log.push(worst.verdict.kind === "warn" ? `[solver] quoted with risk flag (${worst.field} warn) → queued for manual review` : "[solver] quoted normally");
  }
  const event: GuardEvent = { id: randomUUID(), source: "intents-solver", verdict: worst.verdict, action, log, at: (opts.now?.() ?? new Date()).toISOString() };
  opts.emit?.(event);
  return { quoteId: q.quoteId, quoted: action === "quoted", event, verdicts };
}

/**
 * LIVE_INTENTS=1: request a real dry-run quote from 1Click to show these fields
 * exist in real traffic. Never deposits anything (dry: true).
 */
export async function liveDryQuote(req: Partial<OneClickQuoteRequest>, jwt = process.env.ONECLICK_JWT): Promise<unknown> {
  const res = await fetch("https://1click.chaindefuser.com/v0/quote", {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({ ...req, dry: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`1Click ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
