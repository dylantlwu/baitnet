import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Annotation, Correction, PlaybookEntry } from "@baitnet/shared";
import { redactFields } from "./redact.js";
import { dataPath, fixturePath } from "@baitnet/agent";

/**
 * data/training.sqlite (D15: node:sqlite, no native deps).
 * Schema is versioned with PRAGMA user_version; add a new entry to MIGRATIONS to change it.
 * Rows keep the full shared-type object as JSON in `data` plus a few indexed columns.
 */
export type TrainingDb = DatabaseSync;

type Migration = string | ((db: DatabaseSync) => void);

const MIGRATIONS: Migration[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, script_id TEXT NOT NULL, engine TEXT, expert_id TEXT, score REAL,
    created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL, idx INTEGER NOT NULL, side TEXT NOT NULL, author TEXT, text TEXT NOT NULL,
    whisper TEXT, ts TEXT, PRIMARY KEY (session_id, idx));
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, expert_id TEXT NOT NULL,
    rating TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS annotations_session ON annotations(session_id);
  CREATE TABLE IF NOT EXISTS corrections (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, script_id TEXT NOT NULL,
    review TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS corrections_review ON corrections(review);
  CREATE TABLE IF NOT EXISTS playbook (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, scam_type TEXT NOT NULL, stage TEXT NOT NULL,
    source_correction_id TEXT, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY, playbook_version INTEGER NOT NULL, engine TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, lang TEXT NOT NULL, expert_id TEXT, analysis_id TEXT,
    saved_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS script_analyses (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, expert_id TEXT, at TEXT NOT NULL, data TEXT NOT NULL);
  `,
  // v2 (one-off): redact PII already stored in clear in annotations / corrections / playbook
  (db) => {
    redactStoredRows(db);
  },
  // v3 (D32): refresh the shipped seed entries (ids "seed-…") in DBs seeded before D32: chain jargon
  // ("TRC20 还是 ERC20") removed from replies, "are you a bot?" entries added. Expert entries are untouched.
  (db) => {
    if (!(db.prepare("SELECT value FROM meta WHERE key = 'seeded_from'").get() as { value: string } | undefined)) return;
    if (!existsSync(seedPath())) return;
    const seed = JSON.parse(readFileSync(seedPath(), "utf8")) as SeedFile;
    const version = seed.playbookVersion ?? 1;
    const ins = db.prepare("INSERT OR REPLACE INTO playbook (id, version, scam_type, stage, source_correction_id, data) VALUES (?, ?, ?, ?, ?, ?)");
    for (const raw of seed.playbook) {
      if (!raw.id.startsWith("seed-")) continue;
      const old = db.prepare("SELECT version FROM playbook WHERE id = ?").get(raw.id) as { version: number } | undefined;
      const e: PlaybookEntry = redactFields<PlaybookEntry>({ ...(raw as PlaybookEntry), version: old?.version ?? (raw as PlaybookEntry).version ?? version }, ["situation", "badReply", "goodReply", "rationale"]);
      ins.run(e.id, e.version, e.scamType, String(e.stage), e.sourceCorrectionId ?? null, JSON.stringify(e));
    }
  },
];

/** Re-runs the redactor over the free-text fields of every stored row. Idempotent (placeholders are left alone). */
export function redactStoredRows(db: DatabaseSync): { annotations: number; corrections: number; playbook: number } {
  const n = { annotations: 0, corrections: 0, playbook: 0 };
  const pass = <T extends object>(table: keyof typeof n, fields: (keyof T)[]) => {
    const upd = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
    for (const row of db.prepare(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[]) {
      const json = JSON.stringify(redactFields(JSON.parse(row.data) as T, fields));
      if (json !== row.data) {
        upd.run(json, row.id);
        n[table]++;
      }
    }
  };
  pass<Annotation>("annotations", ["note"]);
  pass<Correction>("corrections", ["situation", "badReply", "goodReply", "rationale"]);
  pass<PlaybookEntry>("playbook", ["situation", "badReply", "goodReply", "rationale"]);
  return n;
}

export interface SeedFile {
  playbookVersion?: number;
  playbook: Omit<PlaybookEntry, "version">[] | PlaybookEntry[];
}

export const trainingDbPath = () => dataPath("training.sqlite");
export const seedPath = () => fixturePath("training", "seed.json");

export function migrate(db: TrainingDb): number {
  const cur = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      const m = MIGRATIONS[v]!;
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return MIGRATIONS.length;
}

export function seedDb(db: TrainingDb, seed: SeedFile): void {
  const version = seed.playbookVersion ?? 1;
  const ins = db.prepare("INSERT OR REPLACE INTO playbook (id, version, scam_type, stage, source_correction_id, data) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const raw of seed.playbook) {
    const e: PlaybookEntry = redactFields<PlaybookEntry>({ ...(raw as PlaybookEntry), version: (raw as PlaybookEntry).version ?? version }, ["situation", "badReply", "goodReply", "rationale"]);
    ins.run(e.id, e.version, e.scamType, String(e.stage), e.sourceCorrectionId ?? null, JSON.stringify(e));
  }
  setMeta(db, "playbook_version", String(version));
  setMeta(db, "seeded_from", "fixtures/training/seed.json");
  db.exec("COMMIT");
}

export function getMeta(db: TrainingDb, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}
export function setMeta(db: TrainingDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/**
 * Open (and migrate) a training DB. When the file does not exist yet it is seeded
 * from fixtures/training/seed.json so the offline demo can show retrieval at once.
 * Pass ":memory:" for tests (seeded too unless opts.seed === false).
 */
export function openTrainingDb(path = trainingDbPath(), opts: { seed?: boolean | SeedFile } = {}): TrainingDb {
  const fresh = path === ":memory:" || !existsSync(path);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  if (fresh && opts.seed !== false) {
    const seed = typeof opts.seed === "object" ? opts.seed : existsSync(seedPath()) ? (JSON.parse(readFileSync(seedPath(), "utf8")) as SeedFile) : undefined;
    if (seed) seedDb(db, seed);
    else setMeta(db, "playbook_version", "0");
  }
  return db;
}

let defaultDb: { path: string; db: TrainingDb; pinned?: boolean } | undefined;

/** Process-wide DB at data/training.sqlite (re-opened if BAITNET_DATA_DIR changes, e.g. in tests). */
export function getDefaultDb(): TrainingDb {
  const p = trainingDbPath();
  if (!defaultDb || (!defaultDb.pinned && defaultDb.path !== p)) {
    defaultDb = { path: p, db: openTrainingDb(p) };
  }
  return defaultDb.db;
}

/** Point the default DB at a specific file/handle (server: ctx.dataPath("training.sqlite")). */
export function setDefaultDb(db: TrainingDb, path = trainingDbPath()): void {
  defaultDb = { path, db, pinned: true };
}

export function closeDefaultDb(): void {
  defaultDb?.db.close();
  defaultDb = undefined;
}
