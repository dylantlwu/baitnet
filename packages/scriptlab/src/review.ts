import type { AlertDraft, ScriptAnalysis } from "@baitnet/shared";
import { AccountAgeCheck, KnownEntityFilter, fixturePath, loadKnownEntities, reportDrafts } from "@baitnet/agent";
import { SampleAccountInfo, type RegistryClient } from "@baitnet/guard";
import { getDefaultDb, type TrainingDb } from "@baitnet/training";
import { ScriptLabError } from "./parse.js";
import { getAnalysis, storeAnalysis } from "./store.js";

/** An alert draft from an upload, plus its human-review state (stored in script_analyses.data). */
export type ReviewedAlertDraft = AlertDraft & {
  review: "pending" | "approved" | "rejected";
  reviewer?: string;
  reviewedAt?: string;
  alertId?: number;
  txHash?: string;
};

export type RegistrySource = RegistryClient | (() => RegistryClient | Promise<RegistryClient>);

export interface ReviewDeps {
  registry?: RegistrySource;
  /** M2 anti-poisoning; defaults to fixtures/known-entities.json + account-meta.json samples (+ rpcUrl if given) */
  known?: KnownEntityFilter;
  age?: AccountAgeCheck;
  rpcUrl?: string;
  log?: (line: string) => void;
}

export interface ReviewOutcome {
  draft: ReviewedAlertDraft;
  /** set when the anti-poisoning filter stopped it (never goes on chain) */
  filteredReason?: string;
}

let defaultKnown: KnownEntityFilter | undefined;

export const draftReview = (d: AlertDraft): ReviewedAlertDraft => ({ ...(d as ReviewedAlertDraft), review: (d as Partial<ReviewedAlertDraft>).review ?? "pending" });

/**
 * Human review of one alertDraft from a Script Lab analysis (same gate as the Arena):
 *   approve=false → review "rejected"
 *   approve=true  → M2 anti-poisoning (known-entity list, account age/activity); filtered → review
 *                   "rejected" + filteredReason, NOT reported; otherwise AlertRegistry.report() via M2
 *                   reportDrafts() → review "approved" + alertId/txHash.
 * The state is written back into the analysis row (script_analyses).
 */
export async function reviewAlertDraft(
  analysisId: string,
  draftIndex: number,
  approve: boolean,
  deps: ReviewDeps & { reviewer?: string } = {},
  db: TrainingDb = getDefaultDb(),
): Promise<ReviewOutcome> {
  const a = getAnalysis(analysisId, db);
  if (!a) throw new ScriptLabError(`analysis ${analysisId} not found`, 404, "not-found");
  if (!Number.isInteger(draftIndex) || draftIndex < 0 || draftIndex >= a.alertDrafts.length)
    throw new ScriptLabError(`draftIndex must be an integer in [0, ${a.alertDrafts.length})`, 400, "bad-index");
  if (typeof approve !== "boolean") throw new ScriptLabError("body must be {draftIndex: number, approve: boolean}");
  const cur = draftReview(a.alertDrafts[draftIndex]!);
  if (cur.review !== "pending") throw new ScriptLabError(`draft ${draftIndex} already ${cur.review}`, 409, "already-reviewed");
  const log = deps.log ?? (() => {});
  const stamp = { reviewer: deps.reviewer ?? "reviewer", reviewedAt: new Date().toISOString() };

  let next: ReviewedAlertDraft;
  let filteredReason: string | undefined;
  if (!approve) {
    next = { ...cur, ...stamp, review: "rejected" };
  } else {
    // anti-poisoning first (the analysis may already carry a known-entity reason)
    const known = deps.known ?? (defaultKnown ??= new KnownEntityFilter(loadKnownEntities()));
    const ent = known.match(cur);
    filteredReason = cur.filteredReason ?? (ent ? `known-entity: ${ent.name} (${ent.kind})` : undefined);
    if (!filteredReason) {
      const age = deps.age ?? new AccountAgeCheck(SampleAccountInfo.fromFile(fixturePath("account-meta.json")), { rpcUrl: deps.rpcUrl });
      const r = await age.check(cur);
      if (!r.ok) filteredReason = `age-activity: ${r.detail}`;
    }
    if (filteredReason) {
      log(`[scriptlab] review ${analysisId}#${draftIndex} ${cur.chain}:${cur.address} filtered — ${filteredReason}; NOT reported`);
      next = { ...cur, ...stamp, review: "rejected", filteredReason };
    } else {
      if (!deps.registry) throw new ScriptLabError("registry not configured: pass ctx.registry (RegistryClient) to registerScriptLabRoutes", 503, "no-registry");
      const registry = typeof deps.registry === "function" ? await deps.registry() : deps.registry;
      const lines: string[] = [];
      const [reported] = await reportDrafts(registry, [cur], lines);
      for (const l of lines) log(`[scriptlab] ${l}`);
      if (!reported) throw new ScriptLabError("registry did not report the draft", 502, "report-failed");
      next = { ...cur, ...stamp, review: "approved", alertId: reported.alertId, txHash: reported.txHash };
    }
  }
  const drafts = a.alertDrafts.map((d, i) => (i === draftIndex ? next : d));
  const updated: ScriptAnalysis = { ...a, alertDrafts: drafts };
  const expert = (a.draft.source as { citation?: string })?.citation?.match(/^uploaded by (.+?), /)?.[1] ?? "unknown";
  storeAnalysis(updated, expert, db);
  return { draft: next, filteredReason };
}
