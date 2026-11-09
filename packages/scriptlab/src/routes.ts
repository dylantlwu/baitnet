import type { ScriptAnalysis } from "@baitnet/shared";
import { requestLang, type ScriptUploadInput } from "./analyze.js";
import { analyzeEphemeral, type M10Verifier } from "./ephemeral.js";
import { currentExpert, httpError, trainingDbFor, type RouteContext, type RouterLike } from "@baitnet/training";
import { analyzeUpload, liveEngineAvailable, type AnalyzeOptions } from "./llm.js";
import { ScriptLabError } from "./parse.js";
import { draftReview, reviewAlertDraft, type ReviewDeps } from "./review.js";
import { getAnalysis, listUploadedScripts, saveDraft, storeAnalysis } from "./store.js";

export type ScriptLabContext = RouteContext & {
  analyze?: AnalyzeOptions;
  /** AlertRegistry client for POST /scripts/analyses/:id/review (RegistryClient or a getter) */
  registry?: ReviewDeps["registry"];
  /** NEAR RPC for the M2 account-age check (optional) */
  rpcUrl?: string;
  /** M10 verifier (apps/server/src/attestation.ts module) for zero-retention attestation */
  attestation?: M10Verifier;
};

/** alertDrafts always carry a review state in responses ("pending" until reviewed). */
const withReview = (a: ScriptAnalysis) => ({ ...a, alertDrafts: a.alertDrafts.map(draftReview) });

async function wrap<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ScriptLabError) throw Object.assign(httpError(e.status, e.message), { code: e.code });
    throw e;
  }
}

/**
 *   (expertId / reviewer come from the logged-in user via ctx.currentUser / req.user — never from the body)
 *   POST /scripts/upload              ScriptUpload (or {filename, files[]} for several screenshots in order) → ScriptAnalysis
 *                                     (422 code "image-offline" for screenshots without live mode + Claude key; 413 > 5MB/image)
 *   GET  /scripts/analyses/:id        → ScriptAnalysis
 *   POST /scripts/analyze-ephemeral   same body → ScriptAnalysis & {ephemeral: true, attestation} — NOTHING is stored (D27)
 *   POST /scripts/analyses/:id/save   {draft, analysis?} → saved ScamScriptDef
 *                                     (analysis = the zero-retention result, sent only after the user confirms "save")
 *   POST /scripts/analyses/:id/review {draftIndex, approve} → updated alertDraft
 *        (approve: M2 anti-poisoning → filtered: review "rejected" + filteredReason; else AlertRegistry.report → alertId/txHash)
 *   GET  /scripts/uploaded            → ScamScriptDef[] (saved uploads; Arena merges these)
 *   GET  /scripts/engine              → {engine: "llm"|"rules"} (which engine an upload would use now)
 */
export function registerScriptLabRoutes(router: RouterLike, ctx: ScriptLabContext): void {
  const db = trainingDbFor(ctx);
  ctx.log(`[scriptlab] routes mounted; engine=${liveEngineAvailable(ctx.analyze?.env) ? "llm" : "rules"}`);

  router.post("/scripts/upload", (r) =>
    wrap(async () => {
      const body = r.body as ScriptUploadInput;
      const hasFiles = Array.isArray(body?.files) && body.files.length > 0;
      if (!body || typeof body.filename !== "string" || (!hasFiles && (typeof body.content !== "string" || !["utf8", "base64"].includes(body.encoding))))
        throw new ScriptLabError("body must be a ScriptUpload {filename, content, encoding: utf8|base64, langHint?} or {filename, files: [{filename, content, encoding}]}");
      // identity from the auth middleware only; body.expertId is ignored
      const upload: ScriptUploadInput = { ...body, content: body.content ?? "", encoding: body.encoding ?? "utf8", expertId: await currentExpert(r, ctx) };
      // generated text follows ?lang= / Accept-Language (default zh); Chinese material is always analysed in Chinese
      const a = await analyzeUpload(upload, { ...ctx.analyze, outLang: requestLang(r.query, r.raw?.headers?.["accept-language"] as string | undefined) });
      storeAnalysis(a, upload.expertId, db);
      // never log content: only the redacted summary
      ctx.log(`[scriptlab] ${a.id} ${a.format}/${a.lang} engine=${a.engine} type=${a.scamType.value}(${a.scamType.confidence}) pii=${a.pii.length} drafts=${a.alertDrafts.length}`);
      return withReview(a);
    }),
  );
  // D27 zero-retention: no sqlite, no evidence file, the log line carries no content
  router.post("/scripts/analyze-ephemeral", (r) =>
    wrap(async () => {
      const t0 = Date.now();
      try {
        const body = r.body as ScriptUploadInput;
        const hasFiles = Array.isArray(body?.files) && body.files.length > 0;
        if (!body || typeof body.filename !== "string" || (!hasFiles && typeof body.content !== "string")) throw new ScriptLabError("body must be a ScriptUpload {filename, content, encoding} or {filename, files[]}");
        const upload: ScriptUploadInput = { ...body, content: body.content ?? "", encoding: body.encoding ?? "utf8", expertId: await currentExpert(r, ctx) };
        return await analyzeEphemeral(upload, { env: ctx.analyze?.env, m10: ctx.attestation, outLang: requestLang(r.query, r.raw?.headers?.["accept-language"] as string | undefined) });
      } finally {
        ctx.log(`[scriptlab] 一次零留存分析，耗时 ${Date.now() - t0} ms`);
      }
    }),
  );
  router.get("/scripts/analyses/:id", (r) =>
    wrap(() => {
      const a = getAnalysis(r.params.id!, db);
      if (!a) throw new ScriptLabError("analysis not found", 404, "not-found");
      return withReview(a);
    }),
  );
  router.post("/scripts/analyses/:id/save", (r) =>
    wrap(async () => {
      // body.analysis: a zero-retention result the user explicitly chose to keep (only now does it touch disk)
      const saved = saveDraft(r.params.id!, r.body?.draft, { expertId: await currentExpert(r, ctx), ephemeralAnalysis: r.body?.analysis }, db);
      ctx.log(`[scriptlab] saved script ${saved.id}`);
      return saved;
    }),
  );
  router.post("/scripts/analyses/:id/review", (r) =>
    wrap(async () => {
      const { draftIndex, approve } = r.body ?? {};
      const reviewer = await currentExpert(r, ctx);
      const out = await reviewAlertDraft(r.params.id!, draftIndex, approve, { registry: ctx.registry, rpcUrl: ctx.rpcUrl, log: ctx.log, reviewer }, db);
      ctx.log(`[scriptlab] review ${r.params.id}#${draftIndex} → ${out.draft.review}${out.draft.alertId !== undefined ? ` alert #${out.draft.alertId}` : ""}${out.filteredReason ? ` (${out.filteredReason})` : ""}`);
      return out.draft;
    }),
  );
  router.get("/scripts/uploaded", () => listUploadedScripts(db));
  router.get("/scripts/engine", () => ({ engine: liveEngineAvailable(ctx.analyze?.env) ? "llm" : "rules" }));
}
