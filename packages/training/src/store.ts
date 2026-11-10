import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Annotation, ArenaSession, Correction, PlaybookEntry, ScamScriptDef, ScamType, TurnRating } from "@baitnet/shared";
import { dataPath } from "@baitnet/agent";
import { getDefaultDb, getMeta, setMeta, type TrainingDb } from "./db.js";
import { redactFields } from "./redact.js";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const now = () => new Date().toISOString();

export class TrainingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const RATINGS: TurnRating[] = ["good", "bad", "risky"];
export const SCAM_TYPES: ScamType[] = [
  "investment",
  "pig-butchering",
  "fake-support",
  "fake-airdrop",
  "task-scam",
  "exchange-impersonation",
  "fake-nft-mint",
  "family-emergency",
  "fake-loan",
  "recovery-scam",
];

const str = (v: unknown, field: string, max = 4000): string => {
  if (typeof v !== "string" || !v.trim()) throw new TrainingError(`${field} must be a non-empty string`);
  if (v.length > max) throw new TrainingError(`${field} too long (max ${max})`);
  return v.trim();
};
const int = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new TrainingError(`${field} must be a non-negative integer`);
  return v;
};
const tagList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 64)))] : [];

const rows = <T>(r: unknown[]): T[] => r.map((x) => JSON.parse((x as { data: string }).data) as T);

/** Free-text fields that pass through the PII redactor on write (and in migration v2). */
export const ANNOTATION_TEXT_FIELDS: (keyof Annotation)[] = ["note"];
export const CORRECTION_TEXT_FIELDS: (keyof Correction)[] = ["situation", "badReply", "goodReply", "rationale"];
export const PLAYBOOK_TEXT_FIELDS: (keyof PlaybookEntry)[] = ["situation", "badReply", "goodReply", "rationale"];

/** A demonstration correction has no bad reply: it only teaches what a good line looks like. */
export const isDemonstration = (c: Pick<Correction, "badReply">) => !c.badReply || c.badReply.trim() === "" || c.badReply.trim() === "-";

function normalizeBadReply(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new TrainingError("badReply must be a string (empty = demonstration)");
  const t = v.trim();
  if (t === "-") return "";
  if (t.length > 4000) throw new TrainingError("badReply too long (max 4000)");
  return t;
}

// ───────────────────────── annotations ─────────────────────────

export type AnnotationInput = Omit<Annotation, "id" | "at">;

export function addAnnotation(input: AnnotationInput, db: TrainingDb = getDefaultDb()): Annotation {
  const rating = input?.rating;
  if (!RATINGS.includes(rating)) throw new TrainingError(`rating must be one of ${RATINGS.join("|")}`);
  const a: Annotation = redactFields<Annotation>({
    id: newId("ann"),
    sessionId: str(input.sessionId, "sessionId", 200),
    turnIndex: int(input.turnIndex, "turnIndex"),
    expertId: str(input.expertId, "expertId", 100),
    rating,
    tags: tagList(input.tags),
    note: typeof input.note === "string" ? input.note.slice(0, 2000) : "",
    at: now(),
  }, ANNOTATION_TEXT_FIELDS);
  db.prepare("INSERT INTO annotations (id, session_id, turn_index, expert_id, rating, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    a.id,
    a.sessionId,
    a.turnIndex,
    a.expertId,
    a.rating,
    a.at,
    JSON.stringify(a),
  );
  return a;
}

export function listAnnotations(filter: { sessionId?: string } = {}, db: TrainingDb = getDefaultDb()): Annotation[] {
  return filter.sessionId
    ? rows<Annotation>(db.prepare("SELECT data FROM annotations WHERE session_id = ? ORDER BY turn_index, at").all(filter.sessionId))
    : rows<Annotation>(db.prepare("SELECT data FROM annotations ORDER BY at").all());
}

export function getAnnotation(id: string, db: TrainingDb = getDefaultDb()): Annotation | undefined {
  return rows<Annotation>(db.prepare("SELECT data FROM annotations WHERE id = ?").all(id))[0];
}

export function deleteAnnotation(id: string, db: TrainingDb = getDefaultDb()): boolean {
  return Number(db.prepare("DELETE FROM annotations WHERE id = ?").run(id).changes) > 0;
}

// ───────────────────────── corrections ─────────────────────────

export type CorrectionInput = Omit<Correction, "id" | "at" | "review" | "reviewer">;

export function addCorrection(input: CorrectionInput, db: TrainingDb = getDefaultDb()): Correction {
  if (!input || typeof input !== "object") throw new TrainingError("body must be a Correction");
  if (!SCAM_TYPES.includes(input.scamType)) throw new TrainingError(`scamType must be one of ${SCAM_TYPES.join("|")}`);
  // PII redaction on write (same redactor as Script Lab / Arena): free text never hits the DB in clear
  const c: Correction = redactFields<Correction>({
    id: newId("cor"),
    sessionId: str(input.sessionId, "sessionId", 200),
    turnIndex: int(input.turnIndex, "turnIndex"),
    expertId: str(input.expertId, "expertId", 100),
    scriptId: str(input.scriptId, "scriptId", 200),
    scamType: input.scamType,
    stage: int(input.stage, "stage"),
    situation: str(input.situation, "situation", 1000),
    // "" = demonstration (a ⭐ good line with no bad counterpart); legacy "-" placeholder means the same
    badReply: normalizeBadReply(input.badReply),
    goodReply: str(input.goodReply, "goodReply"),
    rationale: typeof input.rationale === "string" ? input.rationale.slice(0, 2000) : "",
    tags: tagList(input.tags),
    review: "pending",
    at: now(),
  }, CORRECTION_TEXT_FIELDS);
  db.prepare("INSERT INTO corrections (id, session_id, turn_index, script_id, review, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    c.id,
    c.sessionId,
    c.turnIndex,
    c.scriptId,
    c.review,
    c.at,
    JSON.stringify(c),
  );
  return c;
}

export function getCorrection(id: string, db: TrainingDb = getDefaultDb()): Correction | undefined {
  const r = db.prepare("SELECT data FROM corrections WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as Correction) : undefined;
}

export function listCorrections(filter: { review?: Correction["review"] } | Correction["review"] = {}, db: TrainingDb = getDefaultDb()): Correction[] {
  const review = typeof filter === "string" ? filter : filter.review;
  return review
    ? rows<Correction>(db.prepare("SELECT data FROM corrections WHERE review = ? ORDER BY at").all(review))
    : rows<Correction>(db.prepare("SELECT data FROM corrections ORDER BY at").all());
}

/** Deletes a correction that is not yet approved (approved ones are part of the playbook history). */
export function deleteCorrection(id: string, db: TrainingDb = getDefaultDb()): boolean {
  const c = getCorrection(id, db);
  if (!c) return false;
  if (c.review === "approved") throw new TrainingError("approved corrections cannot be deleted (they are in the playbook)", 409);
  return Number(db.prepare("DELETE FROM corrections WHERE id = ?").run(id).changes) > 0;
}

export interface ReviewResult {
  correction: Correction;
  entry?: PlaybookEntry;
  playbookVersion: number;
}

/** Approve → new PlaybookEntry and playbook version + 1. Reject → just marks it. */
export function reviewCorrection(id: string, approve: boolean, reviewer: string, db: TrainingDb = getDefaultDb()): ReviewResult {
  const c = getCorrection(id, db);
  if (!c) throw new TrainingError(`correction ${id} not found`, 404);
  if (c.review !== "pending") throw new TrainingError(`correction ${id} already ${c.review}`, 409);
  const rev = str(reviewer, "reviewer", 100);
  db.exec("BEGIN");
  try {
    const updated: Correction = { ...c, review: approve ? "approved" : "rejected", reviewer: rev };
    db.prepare("UPDATE corrections SET review = ?, data = ? WHERE id = ?").run(updated.review, JSON.stringify(updated), id);
    let entry: PlaybookEntry | undefined;
    let version = getPlaybookVersion(db);
    if (approve) {
      version += 1;
      entry = {
        id: newId("pb"),
        version,
        scamType: c.scamType,
        stage: c.stage,
        situation: c.situation,
        ...(isDemonstration(c) ? {} : { badReply: c.badReply }),
        goodReply: c.goodReply,
        rationale: c.rationale,
        tags: c.tags,
        sourceCorrectionId: c.id,
      };
      insertPlaybookEntry(entry, db);
      setMeta(db, "playbook_version", String(version));
    }
    db.exec("COMMIT");
    return { correction: updated, entry, playbookVersion: version };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ───────────────────────── playbook ─────────────────────────

export function getPlaybookVersion(db: TrainingDb = getDefaultDb()): number {
  return Number(getMeta(db, "playbook_version") ?? 0);
}

export function insertPlaybookEntry(e: PlaybookEntry, db: TrainingDb = getDefaultDb()): void {
  db.prepare("INSERT OR REPLACE INTO playbook (id, version, scam_type, stage, source_correction_id, data) VALUES (?, ?, ?, ?, ?, ?)").run(
    e.id,
    e.version,
    e.scamType,
    String(e.stage),
    e.sourceCorrectionId ?? null,
    JSON.stringify(e),
  );
}

export function listPlaybook(db: TrainingDb = getDefaultDb()): PlaybookEntry[] {
  return rows<PlaybookEntry>(db.prepare("SELECT data FROM playbook ORDER BY version, id").all());
}

// ───────────────────────── sessions / turns ─────────────────────────

/** Store an Arena session (and its turns) so regression cases can replay its prefix. */
export function saveSession(s: ArenaSession, meta: { expertId?: string; score?: number } = {}, db: TrainingDb = getDefaultDb()): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO sessions (id, script_id, engine, expert_id, score, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET script_id=excluded.script_id, engine=excluded.engine, expert_id=COALESCE(excluded.expert_id, sessions.expert_id), score=COALESCE(excluded.score, sessions.score), data=excluded.data",
    ).run(s.id, s.scriptId, s.engine, meta.expertId ?? null, meta.score ?? null, s.createdAt, JSON.stringify(s));
    db.prepare("DELETE FROM turns WHERE session_id = ?").run(s.id);
    const ins = db.prepare("INSERT INTO turns (session_id, idx, side, author, text, whisper, ts) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const t of s.turns) ins.run(s.id, t.index, t.side, t.author, t.text, t.whisper ?? null, t.ts);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface SessionTurnRow {
  idx: number;
  side: "scammer" | "bait";
  author: string | null;
  text: string;
  whisper: string | null;
  ts: string | null;
}

/**
 * Turns of a session: from the sessions/turns tables, else imported from
 * data/arena/sessions/<id>.json (B1's Arena store) on first use.
 */
export function getSessionTurns(sessionId: string, db: TrainingDb = getDefaultDb()): SessionTurnRow[] | undefined {
  const get = () => db.prepare("SELECT idx, side, author, text, whisper, ts FROM turns WHERE session_id = ? ORDER BY idx").all(sessionId) as unknown as SessionTurnRow[];
  let t = get();
  if (t.length) return t;
  if (!/^[\w.-]+$/.test(sessionId)) return undefined;
  const file = dataPath("arena", "sessions", `${sessionId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    saveSession(JSON.parse(readFileSync(file, "utf8")) as ArenaSession, {}, db);
  } catch {
    return undefined;
  }
  t = get();
  return t.length ? t : undefined;
}

export function setSessionScore(sessionId: string, score: number, expertId?: string, db: TrainingDb = getDefaultDb()): boolean {
  return Number(db.prepare("UPDATE sessions SET score = ?, expert_id = COALESCE(?, expert_id) WHERE id = ?").run(score, expertId ?? null, sessionId).changes) > 0;
}

// ───────────────────────── uploaded scripts ─────────────────────────

export function saveUploadedScript(def: ScamScriptDef, meta: { expertId?: string; analysisId?: string } = {}, db: TrainingDb = getDefaultDb()): ScamScriptDef {
  db.prepare(
    "INSERT OR REPLACE INTO scripts (id, type, lang, expert_id, analysis_id, saved_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(def.id, def.type, def.lang, meta.expertId ?? null, meta.analysisId ?? null, now(), JSON.stringify(def));
  return def;
}

/** Saved Script Lab uploads (Arena merges these with fixtures/scripts). */
export function listUploadedScripts(db: TrainingDb = getDefaultDb()): ScamScriptDef[] {
  return rows<ScamScriptDef>(db.prepare("SELECT data FROM scripts ORDER BY saved_at").all());
}

export function getUploadedScript(id: string, db: TrainingDb = getDefaultDb()): ScamScriptDef | undefined {
  const r = db.prepare("SELECT data FROM scripts WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as ScamScriptDef) : undefined;
}
