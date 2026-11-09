import { readFileSync } from "node:fs";
import type { AlertDraft, Chain, FlowEdge, Target } from "@baitnet/shared";
import { safeTargetKey } from "@baitnet/guard";
import { fixturePath } from "../paths.js";
import { chainOfAsset } from "../solver/solver.js";
import { detectChain } from "../extract/extract.js";
import { canonicalJson, sealEvidence, sha256Hex, type SealedEvidence } from "../extract/evidence.js";
import type { KnownEntityFilter } from "../extract/pipeline.js";

/** One item of GET https://explorer.near-intents.org/api/v0/transactions. */
export interface ExplorerTx {
  originAsset: string;
  destinationAsset: string;
  depositAddress: string;
  depositMemo?: string | null;
  recipient: string;
  status: "SUCCESS" | "REFUNDED" | "FAILED" | "PENDING_DEPOSIT" | "PROCESSING" | "INCOMPLETE_DEPOSIT" | string;
  createdAt: string;
  createdAtTimestamp: number;
  intentHashes: string;
  referral?: string;
  amountInFormatted: string;
  amountOutFormatted: string;
  appFees?: unknown[];
  nearTxHashes: string[];
  originChainTxHashes: string[];
  destinationChainTxHashes: { hash: string; explorerUrl?: string }[];
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  refundTo: string;
  senders: string[];
  refundReason?: string | null;
}

export function loadExplorerTxs(path = fixturePath("intents", "explorer-transactions.json")): ExplorerTx[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { data?: ExplorerTx[] } | ExplorerTx[];
  return Array.isArray(raw) ? raw : (raw.data ?? []);
}

let lastLiveCall = 0;
/** Real API (needs Partner JWT; limit 1 req / 5 s). `search` matches deposit address, recipient, sender or tx hash. */
export async function fetchExplorerTxs(search: string, jwt: string): Promise<ExplorerTx[]> {
  const wait = lastLiveCall + 5_100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLiveCall = Date.now();
  const url = new URL("https://explorer.near-intents.org/api/v0/transactions");
  url.searchParams.set("search", search);
  url.searchParams.set("numberOfTransactions", "100");
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Intents Explorer ${res.status}`);
  const body = (await res.json()) as ExplorerTx[] | { data: ExplorerTx[] };
  return Array.isArray(body) ? body : body.data;
}

const norm = (chain: Chain | undefined, a: string) => safeTargetKey({ chain: chain ?? "near", address: a });

export interface TraceResult {
  root: Target;
  edges: FlowEdge[];
  /** downstream addresses (excluding known entities) */
  downstream: (Target & { depth: number; viaTx?: string })[];
  /** downstream hits on known entities (exchange hot wallets etc.) — shown, not flagged */
  exits: (Target & { name: string })[];
}

/** M7: follow funds forward from a flagged address through 1Click swaps (BFS, max depth). */
export function traceForward(root: Target, txs: ExplorerTx[], opts: { maxDepth?: number; known?: KnownEntityFilter } = {}): TraceResult {
  const maxDepth = opts.maxDepth ?? 3;
  const edges: FlowEdge[] = [];
  const downstream: TraceResult["downstream"] = [];
  const exits: TraceResult["exits"] = [];
  const visited = new Set<string>([norm(root.chain, root.address)]);
  let frontier: (Target & { depth: number })[] = [{ ...root, depth: 0 }];
  const ok = txs.filter((t) => t.status === "SUCCESS").sort((a, b) => a.createdAtTimestamp - b.createdAtTimestamp);
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (node.depth >= maxDepth) continue;
      const key = norm(node.chain, node.address);
      for (const tx of ok) {
        if (!tx.senders.some((s) => norm(detectChain(s) ?? node.chain, s) === key)) continue;
        const toChain = detectChain(tx.recipient) ?? chainOfAsset(tx.destinationAsset);
        edges.push({
          from: node.address,
          to: tx.recipient,
          protocol: "near-intents-1click",
          chain: toChain,
          amountUsd: Number(tx.amountOutUsd) || undefined,
          ts: tx.createdAt,
          txHash: tx.nearTxHashes[0] ?? tx.originChainTxHashes[0],
        });
        const tk = norm(toChain, tx.recipient);
        if (visited.has(tk)) continue;
        visited.add(tk);
        const ent = opts.known?.match({ chain: toChain, address: tx.recipient });
        if (ent) {
          exits.push({ chain: toChain, address: tx.recipient, name: ent.name });
          continue; // stop at exchanges/bridges
        }
        const t = { chain: toChain, address: tx.recipient, depth: node.depth + 1 };
        downstream.push({ ...t, viaTx: tx.nearTxHashes[0] });
        next.push(t);
      }
    }
    frontier = next;
  }
  return { root, edges, downstream, exits };
}

/** Turn downstream addresses into L2 drafts with a (public-data) trace evidence record. */
export function l2Drafts(trace: TraceResult, rootAlertId: number, conversationId: string, opts: { seal?: boolean } = {}): { drafts: AlertDraft[]; evidence?: SealedEvidence } {
  if (!trace.downstream.length) return { drafts: [] };
  const record = {
    version: 1 as const,
    kind: "trace" as const,
    addresses: trace.downstream.map((d) => ({ chain: d.chain, address: d.address })),
    urls: [],
    piiCommitment: sha256Hex("no-pii"),
    extra: { rootAlertId, root: trace.root, edges: trace.edges, source: "intents-explorer" },
    createdAt: trace.edges.at(-1)?.ts ?? new Date(0).toISOString(),
  };
  const evidence = opts.seal === false ? undefined : sealEvidence(record, {}, "");
  const evidenceHash = evidence?.evidenceHash ?? sha256Hex(canonicalJson(record));
  return {
    evidence,
    drafts: trace.downstream.map((d) => ({
      chain: d.chain,
      address: d.address,
      level: "L2" as const,
      category: "trace",
      evidenceHash,
      conversationId,
    })),
  };
}
