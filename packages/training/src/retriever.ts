import type { PlaybookEntry, PlaybookQuery } from "@baitnet/shared";
import { getDefaultDb, type TrainingDb } from "./db.js";
import { inferTags } from "./lexicon.js";
import { listPlaybook } from "./store.js";
import { detectLang, tokenize } from "./text.js";

/**
 * Retrieval contract (D15). Callers (Arena bait prompt, rules engine) only see this
 * interface, so TagRetriever can later be swapped for VectorRetriever without changes.
 */
export interface PlaybookRetriever {
  readonly kind: "tag" | "vector";
  search(q: PlaybookQuery): PlaybookEntry[];
}

export interface ScoredEntry {
  entry: PlaybookEntry;
  score: number;
  why: string[];
}

const DEFAULT_K = 3;

function entryLang(e: PlaybookEntry) {
  return detectLang(`${e.situation} ${e.goodReply}`);
}

/**
 * Score one entry for a query. Filters first: scamType and stage must match or be "any".
 * Then: explicit tag overlap ×3, tags inferred from lastScammerText ×2 (this is what lets a
 * Chinese query hit an English entry and vice versa), keyword overlap (en words / zh char
 * bigrams, IDF-weighted) on situation + badReply + tags, small bonuses for exact type/stage
 * and same language. Score 0 → not returned.
 */
export function scoreEntry(e: PlaybookEntry, q: PlaybookQuery, idf: (tok: string) => number = () => 1): ScoredEntry | undefined {
  if (e.scamType !== "any" && e.scamType !== q.scamType) return undefined;
  if (e.stage !== "any" && e.stage !== q.stage) return undefined;
  const why: string[] = [];
  let score = 0;
  const qTags = new Set(q.tags ?? []);
  for (const t of e.tags)
    if (qTags.has(t)) {
      score += 3;
      why.push(`tag:${t}`);
    }
  const inferred = new Set(inferTags(q.lastScammerText ?? ""));
  for (const t of e.tags)
    if (inferred.has(t) && !qTags.has(t)) {
      score += 2;
      why.push(`inferred:${t}`);
    }
  const qTok = new Set(tokenize(q.lastScammerText ?? ""));
  if (qTok.size) {
    const eTok = new Set(tokenize(`${e.situation} ${e.badReply ?? ""} ${e.tags.join(" ")}`));
    let kw = 0;
    const hits: string[] = [];
    for (const t of qTok)
      if (eTok.has(t)) {
        kw += idf(t);
        hits.push(t);
      }
    if (kw > 0) {
      score += Math.min(kw, 6);
      why.push(`kw:${hits.slice(0, 5).join(",")}`);
    }
  }
  if (score === 0) return undefined;
  if (e.scamType === q.scamType) score += 0.5;
  if (e.stage === q.stage) score += 0.25;
  if (q.lastScammerText && entryLang(e) === detectLang(q.lastScammerText)) score += 0.75;
  return { entry: e, score, why };
}

export class TagRetriever implements PlaybookRetriever {
  readonly kind = "tag" as const;
  constructor(private source: () => PlaybookEntry[]) {}

  explain(q: PlaybookQuery): ScoredEntry[] {
    const all = this.source();
    // IDF over the playbook so common bigrams ("转账") count less than rare ones ("助记")
    const df = new Map<string, number>();
    for (const e of all) for (const t of new Set(tokenize(`${e.situation} ${e.badReply ?? ""} ${e.tags.join(" ")}`))) df.set(t, (df.get(t) ?? 0) + 1);
    const n = Math.max(all.length, 1);
    const idf = (t: string) => Math.log(1 + n / (df.get(t) ?? 1));
    return all
      .map((e) => scoreEntry(e, q, idf))
      .filter((x): x is ScoredEntry => !!x)
      .sort((a, b) => b.score - a.score || b.entry.version - a.entry.version || a.entry.id.localeCompare(b.entry.id))
      .slice(0, q.k ?? DEFAULT_K);
  }

  search(q: PlaybookQuery): PlaybookEntry[] {
    return this.explain(q).map((s) => s.entry);
  }
}

/** Tag + keyword retriever over the playbook table (re-reads the table each call; it is small). */
export function createTagRetriever(db?: TrainingDb): TagRetriever {
  return new TagRetriever(() => listPlaybook(db ?? getDefaultDb()));
}

/**
 * TODO(post-hackathon, D15): VectorRetriever once the playbook passes ~1000 entries.
 * Plan:
 *   1. Load the sqlite-vec extension into the same node:sqlite handle
 *      (`new DatabaseSync(path, { allowExtension: true }); db.loadExtension(sqliteVec.getLoadablePath())`).
 *   2. Migration v2: `CREATE VIRTUAL TABLE playbook_vec USING vec0(id TEXT PRIMARY KEY, embedding float[384])`,
 *      filled from situation + badReply via a multilingual embedding model (zh + en), on insert in
 *      reviewCorrection().
 *   3. search(): same scamType/stage pre-filter as TagRetriever, then
 *      `SELECT id FROM playbook_vec WHERE embedding MATCH ? ORDER BY distance LIMIT k`,
 *      optionally re-ranked with scoreEntry() so tags still count.
 *   Callers keep using PlaybookRetriever; only the factory changes.
 */
export class VectorRetriever implements PlaybookRetriever {
  readonly kind = "vector" as const;
  search(_q: PlaybookQuery): PlaybookEntry[] {
    throw new Error("VectorRetriever not implemented yet (D15: TagRetriever until the playbook outgrows it)");
  }
}
