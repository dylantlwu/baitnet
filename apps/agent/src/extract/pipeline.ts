import { readFileSync } from "node:fs";
import type { AlertDraft, Conversation, Target } from "@baitnet/shared";
import { safeTargetKey, rpcQuery, SampleAccountInfo, type RegistryClient } from "@baitnet/guard";
import { fixturePath } from "../paths.js";
import { extractFromConversation, type Extraction } from "./extract.js";
import { sealConversationEvidence, type SealedEvidence } from "./evidence.js";
import { disabledOnchainLookup, onchainVerdict, textWarnings, type OnchainLookup } from "./confusion.js";

export interface KnownEntity {
  chain: Target["chain"];
  address: string;
  name: string;
  kind: string;
  /** D33: where the entry was verified (block explorer / official doc URL) */
  source?: string;
}

export function loadKnownEntities(path = fixturePath("known-entities.json")): KnownEntity[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { entities: KnownEntity[] }).entities;
}

export class KnownEntityFilter {
  private map = new Map<string, KnownEntity>();
  constructor(entities: KnownEntity[]) {
    for (const e of entities) this.map.set(safeTargetKey(e), e);
  }
  match(t: Target): KnownEntity | undefined {
    return this.map.get(safeTargetKey(t));
  }
}

export interface AgeCheckResult {
  ok: boolean;
  detail: string;
  source: "near-rpc" | "sample" | "none";
}

/**
 * Account age / activity check (anti-poisoning). A long-lived, very active
 * account showing up as a "scam address" is more likely a mis-extraction or a
 * framing attempt against a legit party → hold for manual review instead of
 * auto-reporting.
 */
export class AccountAgeCheck {
  constructor(
    private samples: SampleAccountInfo,
    private opts: { rpcUrl?: string; maxAutoAgeDays?: number; now?: () => Date } = {},
  ) {}

  async check(t: Target): Promise<AgeCheckResult> {
    const max = this.opts.maxAutoAgeDays ?? 730;
    const now = this.opts.now?.() ?? new Date();
    const meta = this.samples.get(t);
    if (t.chain === "near" && this.opts.rpcUrl) {
      try {
        const acc = await rpcQuery<{ amount: string; code_hash: string; storage_usage: number }>(this.opts.rpcUrl, {
          request_type: "view_account",
          finality: "final",
          account_id: t.address.toLowerCase(),
        });
        const created = await this.samples.createdAt(t);
        const days = created ? (now.getTime() - created.getTime()) / 86_400_000 : undefined;
        return {
          ok: days === undefined || days <= max,
          detail: `exists on NEAR RPC (storage ${acc.storage_usage}B)${days !== undefined ? `, age ${days.toFixed(0)}d (sample)` : ""}`,
          source: "near-rpc",
        };
      } catch {
        // not on this network: fall through to samples
      }
    }
    if (meta) {
      const created = await this.samples.createdAt(t);
      const days = created ? (now.getTime() - created.getTime()) / 86_400_000 : undefined;
      const ok = days === undefined || days <= max;
      return { ok, detail: days !== undefined ? `age ${days.toFixed(0)}d (sample data)${ok ? "" : ` > ${max}d: long-lived account, hold for review`}` : "no age data", source: "sample" };
    }
    return { ok: true, detail: "no age/activity data (unknown address)", source: "none" };
  }
}

export interface ReviewDecision {
  approved: boolean;
  reviewer: string;
  note: string;
}

/** Human review gate before an L1 goes on chain. Demo: auto-approve, but logged. */
export type Reviewer = (draft: AlertDraft, ctx: { context?: string }) => Promise<ReviewDecision>;

export const autoApproveReviewer: Reviewer = async (draft) =>
  draft.warnings?.length
    ? { approved: false, reviewer: "demo-auto", note: `not auto-approved: ${draft.warnings.length} D33 warning(s) need a human (${draft.warnings.map((w) => w.code).join(", ")})` }
    : { approved: true, reviewer: "demo-auto", note: "auto-approved in demo mode (BAITNET_REVIEW=manual for a real prompt)" };

export interface PipelineResult {
  conversationId: string;
  extraction: Extraction;
  evidence: SealedEvidence;
  /** All drafts, including filtered ones (filteredReason set). */
  drafts: AlertDraft[];
  log: string[];
}

export interface PipelineDeps {
  known: KnownEntityFilter;
  age: AccountAgeCheck;
  reviewer?: Reviewer;
  evidenceKey?: Buffer;
  /** D33 on-chain contract / activity lookup; default off (no network) */
  onchain?: OnchainLookup;
  now?: () => Date;
}

/** M2: conversation → extraction → evidence → drafts (filtered) → review. */
export async function processConversation(conv: Conversation, deps: PipelineDeps): Promise<PipelineResult> {
  const log: string[] = [];
  const ex = extractFromConversation(conv);
  log.push(`[extract] ${ex.addresses.length} address(es), ${ex.urls.length} url(s); ${ex.phones.length + ex.telegrams.length} PII item(s) → encrypted evidence only`);
  const evidence = sealConversationEvidence(conv, ex, deps.evidenceKey);
  log.push(`[evidence] AES-256-GCM sealed → ${evidence.file.split("/").slice(-2).join("/")}; sha256=${evidence.evidenceHash}`);

  const drafts: AlertDraft[] = [];
  for (const a of ex.addresses) {
    const draft: AlertDraft = {
      chain: a.chain,
      address: a.address,
      level: "L1",
      category: conv.script,
      evidenceHash: evidence.evidenceHash,
      conversationId: conv.id,
    };
    const ent = deps.known.match(a);
    if (ent) {
      draft.filteredReason = `known-entity: ${ent.name} (${ent.kind})`;
      log.push(`[filter] ${a.chain}:${a.address} dropped — ${draft.filteredReason}; logged, NOT reported`);
      drafts.push(draft);
      continue;
    }
    const age = await deps.age.check(a);
    if (!age.ok) {
      draft.filteredReason = `age-activity: ${age.detail}`;
      log.push(`[filter] ${a.chain}:${a.address} held — ${age.detail}`);
      drafts.push(draft);
      continue;
    }
    // D33: token contract → filtered; contract / very active / lookup failed / suspicion / chain mismatch → warnings
    const oc = onchainVerdict(await (deps.onchain ?? disabledOnchainLookup).kind(a, a.assetHint), "en", deps.now?.() ?? new Date());
    if (oc.filteredReason) {
      draft.filteredReason = oc.filteredReason;
      log.push(`[filter] ${a.chain}:${a.address} dropped — ${oc.filteredReason}; logged, NOT reported`);
      drafts.push(draft);
      continue;
    }
    const warnings = [...oc.warnings, ...textWarnings(a, conv.turns.map((t) => ({ role: t.role, text: t.text })), "en")];
    if (warnings.length) {
      draft.warnings = warnings;
      log.push(`[warn] ${a.chain}:${a.address} — ${warnings.map((w) => `${w.code}: ${w.detail}`).join("; ")}`);
    }
    log.push(`[filter] ${a.chain}:${a.address} passed (${age.detail}${a.assetHint ? `; hint ${a.assetHint}` : ""})`);
    const review = await (deps.reviewer ?? autoApproveReviewer)(draft, { context: a.context });
    log.push(`[review] L1 ${a.chain}:${a.address} → ${review.approved ? "APPROVED" : "REJECTED"} by ${review.reviewer}: ${review.note}`);
    if (!review.approved) draft.filteredReason = `review-rejected: ${review.note}`;
    drafts.push(draft);
  }
  return { conversationId: conv.id, extraction: ex, evidence, drafts, log };
}

export interface ReportedDraft {
  draft: AlertDraft;
  alertId: number;
  txHash?: string;
}

/** Send approved drafts to AlertRegistry.report. Filtered drafts never go on chain. */
export async function reportDrafts(registry: RegistryClient, drafts: AlertDraft[], log: string[] = []): Promise<ReportedDraft[]> {
  const out: ReportedDraft[] = [];
  for (const d of drafts) {
    if (d.filteredReason) continue;
    const r = await registry.report({ address: d.address, chain: d.chain, evidenceHash: d.evidenceHash, level: d.level, category: d.category });
    log.push(`[report] ${d.level} ${d.chain}:${d.address} → alert #${r.value} tx ${r.txHash ?? "-"}`);
    out.push({ draft: d, alertId: r.value, txHash: r.txHash });
  }
  return out;
}
