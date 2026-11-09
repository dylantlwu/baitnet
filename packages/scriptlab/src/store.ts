import type { ScamScriptDef, ScriptAnalysis } from "@baitnet/shared";
import { sealEvidence, type PublicEvidence } from "@baitnet/agent";
import { getDefaultDb, getUploadedScript, listUploadedScripts as listSaved, saveUploadedScript, type TrainingDb } from "@baitnet/training";
import { redactScript, toUploadId } from "./analyze.js";
import { ScriptLabError } from "./parse.js";
import { Redactor } from "./redact.js";
import { validateScriptDef } from "./validate.js";

/** Analyses are kept (redacted only) in training.sqlite → script_analyses, so a restart does not lose them. */
export function storeAnalysis(a: ScriptAnalysis, expertId: string, db: TrainingDb = getDefaultDb()): void {
  db.prepare("INSERT OR REPLACE INTO script_analyses (id, filename, expert_id, at, data) VALUES (?, ?, ?, ?, ?)").run(a.id, a.filename, expertId ?? null, a.at, JSON.stringify(a));
}

export function getAnalysis(id: string, db: TrainingDb = getDefaultDb()): ScriptAnalysis | undefined {
  const r = db.prepare("SELECT data FROM script_analyses WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as ScriptAnalysis) : undefined;
}

/**
 * Save the expert-edited draft into the scripts table. Re-validates, re-redacts every
 * free-text field (an edit must not re-introduce PII), and forces
 * source = {citation: "uploaded by <expertId>, <filename>"}.
 */
export function saveDraft(
  analysisId: string,
  draft: ScamScriptDef,
  opts: { expertId?: string; ephemeralAnalysis?: ScriptAnalysis & { ephemeral?: boolean } } = {},
  db: TrainingDb = getDefaultDb(),
): ScamScriptDef {
  let a = getAnalysis(analysisId, db);
  if (!a && opts.ephemeralAnalysis) a = adoptEphemeral(analysisId, opts.ephemeralAnalysis, opts.expertId ?? "unknown", db);
  if (!a) throw new ScriptLabError(`analysis ${analysisId} not found`, 404, "not-found");
  if (!draft || typeof draft !== "object") throw new ScriptLabError("body must be {draft: ScamScriptDef}");
  const expertId = opts.expertId || (a.draft.source as { citation?: string })?.citation?.match(/^uploaded by (.+?), /)?.[1] || "unknown";
  let id = typeof draft.id === "string" && draft.id.startsWith("upload-") ? draft.id : toUploadId(String(draft.id ?? draft.type ?? "script"), analysisId);
  // an edit of a different analysis must not overwrite someone else's saved script
  const existing = getUploadedScript(id, db);
  if (existing && !db.prepare("SELECT 1 FROM scripts WHERE id = ? AND analysis_id = ?").get(id, analysisId)) id = toUploadId(id, analysisId + Date.now().toString(36));
  const r = new Redactor();
  r.collectNames([draft.persona, draft.hook, ...(draft.stages ?? []).flatMap((s) => s.sampleLines ?? [])].filter((x) => typeof x === "string").join("\n"));
  const candidate: ScamScriptDef = { ...draft, id, source: { citation: `uploaded by ${expertId}, ${a.filename}` } };
  const errs = validateScriptDef(candidate);
  if (errs.length) throw new ScriptLabError(`invalid draft: ${errs.join("; ")}`, 400, "invalid-draft");
  const clean = { ...redactScript(candidate, r), id, source: candidate.source };
  return saveUploadedScript(clean, { expertId, analysisId }, db);
}

/**
 * A zero-retention analysis the user confirmed to keep: it comes back from the browser, so it is
 * untrusted — re-redact the transcript, keep only redacted fields, seal the (redacted) public record
 * so its evidenceHash has an evidence file behind it, then store it like a normal analysis.
 * The original upload was never kept and cannot be recovered.
 */
function adoptEphemeral(analysisId: string, raw: ScriptAnalysis & { ephemeral?: boolean }, expertId: string, db: TrainingDb): ScriptAnalysis {
  if (!raw || raw.id !== analysisId || raw.ephemeral !== true || typeof raw.redactedText !== "string" || !Array.isArray(raw.alertDrafts))
    throw new ScriptLabError(`analysis ${analysisId} not found`, 404, "not-found");
  const r = new Redactor();
  r.collectNames(raw.redactedText);
  const redactedText = r.redact(raw.redactedText);
  const record = {
    version: 1,
    kind: "script-upload",
    filename: String(raw.filename ?? "upload"),
    redactedText,
    addresses: raw.alertDrafts.map((d) => ({ chain: d.chain, address: d.address })),
    urls: (raw.artifacts ?? []).filter((x) => x.kind === "url").map((x) => x.value),
  };
  const sealed = sealEvidence(record as unknown as PublicEvidence, { note: "zero-retention analysis saved by user; original upload was never stored" }, "");
  const { attestation: _att, ephemeral: _e, ...rest } = raw as ScriptAnalysis & { attestation?: unknown; ephemeral?: boolean };
  const a: ScriptAnalysis = {
    ...rest,
    redactedText,
    alertDrafts: raw.alertDrafts.map((d) => ({ chain: d.chain, address: d.address, level: "L1", category: d.category, evidenceHash: sealed.evidenceHash, conversationId: analysisId, ...(d.filteredReason ? { filteredReason: d.filteredReason } : {}) })),
    warnings: [...(raw.warnings ?? []), "零留存分析结果经用户确认后保存；原文从未落盘 / saved from a zero-retention analysis; the original was never stored"],
  };
  storeAnalysis(a, expertId, db);
  return a;
}

/** Saved uploads (also re-exported by @baitnet/training). */
export function listUploadedScripts(db: TrainingDb = getDefaultDb()): ScamScriptDef[] {
  return listSaved(db);
}
