import type { ReviewDeps } from "@baitnet/scriptlab";
import type { ScriptLabApi } from "./types.js";

type ScriptLabModule = typeof import("@baitnet/scriptlab");

/**
 * Build ImDeps.scriptlab from the @baitnet/scriptlab module (server and dev runner share this).
 * analyzeUpload also stores the analysis so「存为剧本」and reviews work later.
 */
export function scriptlabFromModules(
  sl: ScriptLabModule,
  opts: { analyze?: Parameters<ScriptLabModule["analyzeUpload"]>[1]; registry?: ReviewDeps["registry"]; log?: (s: string) => void } = {},
): ScriptLabApi {
  return {
    async analyzeUpload(u) {
      const a = await sl.analyzeUpload(u, opts.analyze);
      sl.storeAnalysis(a, u.expertId);
      opts.log?.(`[im] upload ${a.id} ${a.format}/${a.lang} engine=${a.engine} type=${a.scamType.value} pii=${a.pii.length} drafts=${a.alertDrafts.length}`);
      return a;
    },
    save(analysisId, { expertId }) {
      const a = sl.getAnalysis(analysisId);
      if (!a) throw new Error(`analysis ${analysisId} not found`);
      return sl.saveDraft(analysisId, a.draft, { expertId });
    },
    ...(opts.registry
      ? {
          async reviewDraft(analysisId: string, draftIndex: number, approve: boolean, reviewer: string) {
            const out = await sl.reviewAlertDraft(analysisId, draftIndex, approve, { registry: opts.registry, reviewer, log: opts.log });
            return out.draft;
          },
        }
      : {}),
  };
}
