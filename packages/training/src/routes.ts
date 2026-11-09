import type { IncomingMessage } from "node:http";
import type { Correction, PlaybookQuery } from "@baitnet/shared";
import { openTrainingDb, setDefaultDb, type TrainingDb } from "./db.js";
import { listEvalRuns } from "./regression.js";
import { createTagRetriever } from "./retriever.js";
import {
  addAnnotation,
  addCorrection,
  deleteAnnotation,
  deleteCorrection,
  listAnnotations,
  listCorrections,
  listPlaybook,
  getPlaybookVersion,
  reviewCorrection,
  saveSession,
  setSessionScore,
  SCAM_TYPES,
  TrainingError,
} from "./store.js";

// Structural copy of apps/server's router contract (docs/dev/server-routes.md).
export interface AuthUser {
  id: string; // becomes expertId / reviewer
  name?: string;
  role?: string;
}
export interface RouteRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  raw?: IncomingMessage;
  /** set by B1's auth middleware (alternative to ctx.currentUser) */
  user?: AuthUser;
}
export type RouteHandler = (req: RouteRequest) => unknown | Promise<unknown>;
export interface RouterLike {
  get(path: string, h: RouteHandler): void;
  post(path: string, h: RouteHandler): void;
}
export interface RouteContext {
  log: (line: string) => void;
  dataPath: (...p: string[]) => string;
  /** optional: inject a DB (tests) */
  db?: TrainingDb;
  /** B1 auth: resolves the logged-in user for a request. expertId/reviewer come ONLY from here (or req.user). */
  currentUser?: (req: RouteRequest) => AuthUser | undefined | Promise<AuthUser | undefined>;
  /** true → 401 when no user is resolved (default: true whenever currentUser is provided) */
  requireAuth?: boolean;
}

/** Local single-user fallback when the server runs without auth (D15 local mode). */
export const LOCAL_EXPERT = "local-expert";

/**
 * Who is calling. Never trusts body.expertId / body.reviewer: identity comes from
 * ctx.currentUser(req) or req.user (B1's auth middleware). Without auth configured
 * (local dev) every request is LOCAL_EXPERT.
 */
export async function currentExpert(req: RouteRequest, ctx: RouteContext): Promise<string> {
  const u = (await ctx.currentUser?.(req)) ?? req.user;
  if (u?.id) return String(u.id).slice(0, 100);
  if (ctx.requireAuth ?? !!ctx.currentUser) throw httpError(401, "login required");
  return LOCAL_EXPERT;
}

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Map TrainingError (has .status) through; the server turns {status} into the HTTP code. */
export async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TrainingError) throw httpError(e.status, e.message);
    throw e;
  }
}

/** Opens ctx.dataPath("training.sqlite") once and makes it the process default (so B1's direct calls hit the same DB). */
export function trainingDbFor(ctx: RouteContext): TrainingDb {
  if (ctx.db) return ctx.db;
  const path = ctx.dataPath("training.sqlite");
  const cached = dbByPath.get(path);
  if (cached) return cached;
  const db = openTrainingDb(path);
  dbByPath.set(path, db);
  setDefaultDb(db, path);
  return db;
}
const dbByPath = new Map<string, TrainingDb>();

/**
 * training/* + eval/runs (shared API):
 *   GET  /training/annotations?sessionId=     POST /training/annotations (Annotation w/o id, at)
 *   POST /training/annotations/:id/delete
 *   GET  /training/corrections?review=        POST /training/corrections (Correction w/o id, at, review)
 *   (expertId / reviewer always come from the logged-in user — see currentExpert — never from the body)
 *   POST /training/corrections/:id/review {approve} → {correction, entry?, playbookVersion}
 *   POST /training/corrections/:id/delete     (pending/rejected only)
 *   GET  /training/playbook                   POST /training/playbook/search (PlaybookQuery)
 *   GET  /training/playbook/version → {version}
 *   POST /training/sessions {session: ArenaSession, expertId?, score?}   (store for regression replay)
 *   POST /training/sessions/:id/score {score, expertId?}
 *   GET  /eval/runs → EvalRun[]
 */
export function registerTrainingRoutes(router: RouterLike, ctx: RouteContext): void {
  const db = trainingDbFor(ctx);
  const retriever = createTagRetriever(db);
  ctx.log(`[training] routes mounted; playbook v${getPlaybookVersion(db)} (${listPlaybook(db).length} entries)`);

  router.get("/training/annotations", (r) => listAnnotations({ sessionId: r.query.get("sessionId") ?? undefined }, db));
  router.post("/training/annotations", async (r) => {
    const expertId = await currentExpert(r, ctx);
    return guarded(() => addAnnotation({ ...(r.body ?? {}), expertId }, db));
  });
  router.post("/training/annotations/:id/delete", (r) =>
    guarded(() => {
      if (!deleteAnnotation(r.params.id!, db)) throw httpError(404, "annotation not found");
      return { deleted: r.params.id };
    }),
  );

  router.get("/training/corrections", (r) => {
    const review = r.query.get("review") as Correction["review"] | null;
    if (review && !["pending", "approved", "rejected"].includes(review)) throw httpError(400, "review must be pending|approved|rejected");
    return listCorrections({ review: review ?? undefined }, db);
  });
  router.post("/training/corrections", async (r) => {
    const expertId = await currentExpert(r, ctx);
    return guarded(() => addCorrection({ ...(r.body ?? {}), expertId }, db));
  });
  router.post("/training/corrections/:id/review", async (r) => {
    const reviewer = await currentExpert(r, ctx);
    return guarded(() => {
      const { approve } = r.body ?? {};
      if (typeof approve !== "boolean") throw httpError(400, "body must be {approve: boolean, reviewer: string}");
      const res = reviewCorrection(r.params.id!, approve, reviewer, db);
      ctx.log(`[training] correction ${r.params.id} ${approve ? "approved → playbook v" + res.playbookVersion : "rejected"} by ${reviewer}`);
      return res;
    });
  });
  router.post("/training/corrections/:id/delete", (r) =>
    guarded(() => {
      if (!deleteCorrection(r.params.id!, db)) throw httpError(404, "correction not found");
      return { deleted: r.params.id };
    }),
  );

  router.get("/training/playbook", () => listPlaybook(db));
  router.get("/training/playbook/version", () => ({ version: getPlaybookVersion(db) }));
  router.post("/training/playbook/search", (r) => {
    const q = r.body as PlaybookQuery | undefined;
    if (!q || !SCAM_TYPES.includes(q.scamType) || typeof q.stage !== "number") throw httpError(400, "body must be a PlaybookQuery {scamType, stage, lastScammerText, tags?, k?}");
    return retriever.search({ ...q, lastScammerText: String(q.lastScammerText ?? ""), k: Math.min(Math.max(q.k ?? 3, 1), 20) });
  });

  router.post("/training/sessions", async (r) => {
    const expertId = await currentExpert(r, ctx);
    return guarded(() => {
      const { session, score } = r.body ?? {};
      if (!session?.id || !Array.isArray(session.turns)) throw httpError(400, "body must be {session: ArenaSession, expertId?, score?}");
      saveSession(session, { expertId, score }, db);
      return { saved: session.id };
    });
  });
  router.post("/training/sessions/:id/score", async (r) => {
    const expertId = await currentExpert(r, ctx);
    const { score } = r.body ?? {};
    if (typeof score !== "number") throw httpError(400, "body must be {score: number, expertId?}");
    if (!setSessionScore(r.params.id!, score, expertId, db)) throw httpError(404, "session not stored; POST /training/sessions first");
    return { ok: true };
  });

  router.get("/eval/runs", () => listEvalRuns(db));
}

// ───────────── tiny in-process router (tests / scripts; mirrors the server contract) ─────────────

export interface MiniRouter extends RouterLike {
  dispatch(method: "GET" | "POST", path: string, body?: unknown, user?: AuthUser, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>;
}

export function createMiniRouter(): MiniRouter {
  const routes: { method: string; re: RegExp; keys: string[]; h: RouteHandler }[] = [];
  const add = (method: string) => (path: string, h: RouteHandler) => {
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        path.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, re, keys, h });
  };
  return {
    get: add("GET"),
    post: add("POST"),
    async dispatch(method, fullPath, body, user, headers) {
      const url = new URL(fullPath, "http://x");
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        try {
          const out = await r.h({ params, query: url.searchParams, body, user, raw: headers ? ({ headers } as unknown as IncomingMessage) : undefined });
          return out === undefined ? { status: 204, body: undefined } : { status: 200, body: JSON.parse(JSON.stringify(out)) };
        } catch (e) {
          const status = (e as { status?: number }).status ?? 500;
          return { status, body: { error: (e as Error).message } };
        }
      }
      return { status: 404, body: { error: "no route" } };
    },
  };
}
