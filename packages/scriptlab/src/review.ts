import type { AlertDraft, Lang, ScriptAnalysis } from "@baitnet/shared";
import {
  AccountAgeCheck,
  KnownEntityFilter,
  UnconfirmedWarningsError,
  fixturePath,
  loadKnownEntities,
  mergeWarnings,
  onchainLookupFromEnv,
  onchainVerdict,
  reportDrafts,
  type OnchainLookup,
} from "@baitnet/agent";
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
  /** D33 on-chain contract / activity lookup; default from env (off unless BAITNET_ONCHAIN_LOOKUP=on) */
  onchain?: OnchainLookup;
  log?: (line: string) => void;
}

/**
 * D33 on-chain checks on analysis drafts: token contract → filteredReason; contract / very active / lookup failed
 * → warnings. Drafts already filtered are left alone. Returns the same array when nothing changed.
 */
export async function applyOnchainChecks<D extends AlertDraft>(drafts: D[], lookup: OnchainLookup, lang: Lang, now = new Date()): Promise<D[]> {
  let changed = false;
  const out = await Promise.all(
    drafts.map(async (d) => {
      if (d.filteredReason) return d;
      const v = onchainVerdict(await lookup.kind(d), lang, now);
      if (v.filteredReason) {
        changed = true;
        return { ...d, filteredReason: v.filteredReason };
      }
      if (!v.warnings.length) return d;
      changed = true;
      return { ...d, warnings: mergeWarnings(d.warnings, v.warnings) };
    }),
  );
  return changed ? out : drafts;
}

export interface ReviewOutcome {
  draft: ReviewedAlertDraft;
  /** set when the anti-poisoning filter stopped it (never goes on chain) */
  filteredReason?: string;
}

const uploaderOf = (a: ScriptAnalysis) => (a.draft.source as { citation?: string })?.citation?.match(/^uploaded by (.+?), /)?.[1] ?? "unknown";

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
  deps: ReviewDeps & { reviewer?: string; confirmWarnings?: boolean } = {},
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
    if (!filteredReason) {
      // D33: look the address up again now (the analysis may be old, or was made with the lookup off)
      const [checked] = await applyOnchainChecks([cur], deps.onchain ?? onchainLookupFromEnv(), a.lang);
      filteredReason = checked!.filteredReason;
      if (!filteredReason) {
        const fresh = (checked!.warnings ?? []).filter((w) => !(cur.warnings ?? []).some((x) => x.code === w.code));
        if (fresh.length) {
          // new warnings the reviewer has not seen yet: store them (draft stays pending) and ask again
          const withNew: ReviewedAlertDraft = { ...cur, warnings: mergeWarnings(cur.warnings, fresh) };
          storeAnalysis({ ...a, alertDrafts: a.alertDrafts.map((d, i) => (i === draftIndex ? withNew : d)) }, uploaderOf(a), db);
          throw new UnconfirmedWarningsError(withNew.warnings!);
        }
        if (cur.warnings?.length && deps.confirmWarnings !== true) throw new UnconfirmedWarningsError(cur.warnings);
      }
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
      if (cur.warnings?.length) log(`[scriptlab] review ${analysisId}#${draftIndex}: ${stamp.reviewer} confirmed ${cur.warnings.length} warning(s): ${cur.warnings.map((w) => w.code).join(", ")}`);
    }
  }
  const drafts = a.alertDrafts.map((d, i) => (i === draftIndex ? next : d));
  const updated: ScriptAnalysis = { ...a, alertDrafts: drafts };
  storeAnalysis(updated, uploaderOf(a), db);
  return { draft: next, filteredReason };
}
