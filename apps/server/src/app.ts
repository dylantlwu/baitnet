import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ArenaManager, training } from "@baitnet/arena";
import type { RegistryClient } from "@baitnet/guard";
import { dataPath } from "@baitnet/agent";
import { HANDLED, Router, httpError, readJsonBody, type RouteContext } from "./router.js";
import { registerArenaRoutes } from "./arena-routes.js";
import { SSE_HEADERS, serveStatic } from "./static.js";
import { IdentityStore, LOCAL_IDENTITY, RateLimiter, auditAction, auditDetail, authEnabled, readCookie, requiredRole, telegramBotUsername, type Identity, type Links } from "./auth.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { existsSync, statSync, watchFile, unwatchFile, openSync, readSync, closeSync } from "node:fs";
import type { AttestationResult, Chain, GuardEvent } from "@baitnet/shared";
import { eventsFile, readEvents } from "@baitnet/agent";
import { DataSource } from "./data.js";
import { AttestationCache, DEFAULT_ATTESTATION_CACHE_MS, getAttestation } from "./attestation.js";
import * as m10 from "./attestation.js";

const CHAINS: Chain[] = ["near", "evm", "tron", "btc"];
/** CORS only for the Vite dev server; production is same-origin (server hosts apps/web/dist). */
const ALLOWED_ORIGINS = (process.env.BAITNET_CORS_ORIGINS ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173,http://127.0.0.1:5173")).split(",").filter(Boolean);

export interface AppOptions {
  data?: DataSource;
  log?: (s: string) => void;
  /** override attestation (tests) */
  attestation?: () => Promise<AttestationResult>;
  eventsPollMs?: number;
  arena?: ArenaManager;
  /** mount B2's training / scriptlab routes (default true) */
  mountTraining?: boolean;
  identity?: IdentityStore;
  /** start the IM bridge when TELEGRAM_BOT_TOKEN is set (default true) */
  startIm?: boolean;
  /** extra startIm options (tests: fake Bot API base, env, stateFile, random) */
  imOptions?: { env?: NodeJS.ProcessEnv; telegramApiBase?: string; stateFile?: string; random?: () => number; now?: () => Date };
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin); // echoed, never "*" (cookies)
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, last-event-id");
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Tails data/events.jsonl (written by the agent) and fans new GuardEvents out to SSE clients. */
class EventTail {
  private clients = new Set<ServerResponse>();
  private offset = 0;
  private file = eventsFile();
  private watching = false;
  constructor(private pollMs: number) {
    this.offset = existsSync(this.file) ? statSync(this.file).size : 0;
  }
  add(res: ServerResponse) {
    this.clients.add(res);
    if (!this.watching) {
      this.watching = true;
      watchFile(this.file, { interval: this.pollMs }, () => this.poll());
    }
  }
  remove(res: ServerResponse) {
    this.clients.delete(res);
  }
  poll() {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (size < this.offset) this.offset = 0; // truncated (new demo run)
    if (size === this.offset) return;
    const fd = openSync(this.file, "r");
    const buf = Buffer.alloc(size - this.offset);
    readSync(fd, buf, 0, buf.length, this.offset);
    closeSync(fd);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return;
    this.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      try {
        this.broadcast(JSON.parse(line) as GuardEvent);
      } catch {
        /* skip partial */
      }
    }
  }
  broadcast(e: GuardEvent) {
    for (const c of this.clients) c.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  }
  close() {
    unwatchFile(this.file);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

export type App = Server & {
  stopIm(): Promise<void>;
  /** Pre-load the registry cache and the attestation so the first visitor does not wait (production start). */
  warm(): Promise<void>;
  tail: EventTail;
  data: DataSource;
  arena: ArenaManager;
  router: Router;
  ready: Promise<void>;
  identity: IdentityStore;
  links: Links;
  attestation: AttestationCache;
};

export function createApp(opts: AppOptions = {}): App {
  const log = opts.log ?? ((s: string) => console.log(s));
  const data = opts.data ?? new DataSource(log);
  const tail = new EventTail(opts.eventsPollMs ?? 500);
  const identity = opts.identity ?? new IdentityStore(dataPath("auth.sqlite"));
  const links: Links = { publicUrl: process.env.BAITNET_PUBLIC_URL };
  const arena =
    opts.arena ??
    new ArenaManager({
      log,
      stepDelayMs: Number(process.env.ARENA_STEP_MS ?? 900),
      // per-person daily LLM limit (web with BAITNET_AUTH=on, and IM users); the local owner is unlimited only
      // while auth is off — with auth on nobody is "local-expert", so that id must not unlock unlimited calls
      llmQuota: (ownerId) => (!authEnabled() && ownerId === LOCAL_IDENTITY.expertId ? true : identity.consumeLlmQuota(ownerId)),
    });
  const router = new Router();
  let attCache: { at: number; value: AttestationResult } | undefined;
  // GET /attestation is public and polled by every dashboard: serve the cached result, refresh in the background
  const attestation = new AttestationCache(opts.attestation ?? (() => getAttestation({ log })), {
    ttlMs: Number(process.env.BAITNET_ATTESTATION_CACHE_MS ?? DEFAULT_ATTESTATION_CACHE_MS),
    log,
  });
  const attest = () => attestation.get();

  // ---------------------------------------------------------------- core endpoints
  router.get("/", () => {
    const env = data.getEnv();
    return { ok: true, mode: env.mode, network: env.network, registry: env.registry.contractId, warning: data.warning };
  });
  router.get("/health", () => {
    const env = data.getEnv();
    return { ok: true, mode: env.mode, network: env.network, registry: env.registry.contractId, warning: data.warning };
  });
  registerAuthRoutes(router, identity, () => links, log);
  router.get("/alerts", () => data.alerts());
  router.get("/alerts/:id/evidence", async ({ params }) => {
    const ev = await data.evidence(Number(params.id));
    if (!ev) throw httpError(404, "evidence not found");
    return ev;
  });
  router.get("/alerts/:id", async ({ params }) => {
    const a = (await data.alerts()).find((x) => x.id === Number(params.id));
    if (!a) throw httpError(404, "alert not found");
    return a;
  });
  router.get("/check", async ({ query }) => {
    const chain = query.get("chain") as Chain | null;
    const address = query.get("address");
    if (!chain || !CHAINS.includes(chain) || !address) throw httpError(400, "usage: /check?chain=near|evm|tron|btc&address=…");
    return (await data.getGuard()).check({ chain, address });
  });
  router.get("/events", ({ query, raw, res }) => {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders?.();
    res.write(": baitnet guard events\n\n");
    if (query.get("replay") !== "0") for (const e of readEvents()) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    tail.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    raw.on("close", () => {
      clearInterval(ping);
      tail.remove(res);
    });
    return HANDLED;
  });
  router.get("/flows/:alertId", ({ params }) => data.flows(Number(params.alertId)));
  router.get("/responders", () => data.responders());
  router.get("/acks", async () => data.acks(await data.alerts()));
  router.get("/attestation", async () => {
    const value = await attest();
    if (value.recorded) attCache = { at: Date.now(), value };
    return value;
  });
  router.get("/snapshot", async () => {
    const att = attCache && Date.now() - attCache.at < 600_000 ? attCache.value : undefined;
    return data.snapshot(att, arena);
  });

  // ---------------------------------------------------------------- arena + B2
  registerArenaRoutes(router, arena, { authEnabled });
  const ctx: RouteContext = { log, dataPath };
  // in-memory accounting for /scripts/analyze-ephemeral (D27): persisted daily usage + this counter
  // must stay under the daily limit; plus 5 calls/min per person. Reset on restart (documented).
  const ephemeralPerMinute = new RateLimiter(5, 60_000);
  const ephemeralToday = new Map<string, number>();
  const ephemeralGate = (userId: string): string | undefined => {
    const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
    const used = identity.usedToday(userId) + (ephemeralToday.get(key) ?? 0);
    if (used >= identity.dailyLimit) return "daily LLM quota used up";
    if (!ephemeralPerMinute.allow(userId)) return "too many zero-retention analyses, max 5 per minute";
    ephemeralToday.set(key, (ephemeralToday.get(key) ?? 0) + 1);
    return undefined;
  };
  let im: { stop(): Promise<void> } | undefined;
  const ready = (async () => {
    links.telegramBot = await telegramBotUsername();
    try {
      await arena.restore();
    } catch (e) {
      log(`[server] arena restore failed: ${(e as Error).message}`);
    }
    if (opts.mountTraining === false) return;
    const t = await training();
    for (const [name, fn] of [["registerTrainingRoutes", t.registerTrainingRoutes], ["registerScriptLabRoutes", t.registerScriptLabRoutes]] as const) {
      if (!fn) {
        log(`[server] ${name} not available yet (B2 package missing) — skipped`);
        continue;
      }
      try {
        // registry: B2's /scripts/analyses/:id/review reports approved drafts on chain (503 without it)
        // attestation: M10 fetch/verify module for zero-retention analysis (D27, docs/dev/zero-retention.md)
        await fn(router, { ...ctx, registry: () => data.registry, rpcUrl: data.getEnv().runtime?.rpcUrl, attestation: m10 });
        log(`[server] mounted ${name}`);
      } catch (e) {
        log(`[server] ${name} failed: ${(e as Error).message}`);
      }
    }
    if (opts.startIm !== false && (process.env.TELEGRAM_BOT_TOKEN || opts.imOptions?.env?.TELEGRAM_BOT_TOKEN))
      im = await startImBridge({ identity, arena, links, log, registry: () => data.registry, imOptions: opts.imOptions });
  })();

  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await ready;
      // browsers asking for "/" get the SPA (prod); API clients still get the health JSON
      if (url.pathname === "/" && /text\/html/.test(String(req.headers.accept ?? "")) && serveStatic(req, res, "/index.html")) return;
      const m = router.match(req.method ?? "GET", url.pathname);
      if (m === null) {
        if (serveStatic(req, res, url.pathname)) return;
        return json(res, 404, { error: "not found" });
      }
      if (m === "method") return json(res, 405, { error: "method not allowed" });
      // ---- identity + policy (BAITNET_AUTH=on); otherwise everyone is the local reviewer.
      // With auth on, a visitor without a session is nobody (user undefined) — never the local reviewer.
      let user: Identity | undefined = authEnabled() ? undefined : LOCAL_IDENTITY;
      if (authEnabled()) {
        const need = requiredRole(req.method ?? "GET", m.pattern);
        const who = identity.identify(readCookie(req));
        if (who) user = who;
        if (need !== "public" && !who) return json(res, 401, { error: "login required" });
        if (need === "reviewer" && who?.role !== "reviewer") return json(res, 403, { error: "reviewer only" });
      }
      // zero-retention analysis calls NEAR AI but must not write anything: quota is counted in memory
      if (authEnabled() && m.pattern === "/scripts/analyze-ephemeral") {
        const gate = ephemeralGate(user!.expertId); // expert route: requiredRole guaranteed a login
        if (gate) return json(res, 429, { error: gate });
      }
      const body = await readJsonBody(req);
      if (authEnabled() && body && typeof body === "object" && !Array.isArray(body)) {
        // never trust identity fields from the client
        if ("expertId" in body || /^\/(training|scripts|arena)\//.test(m.pattern)) {
          if (user) body.expertId = user.expertId;
          else delete body.expertId;
        }
        if (/\/review$/.test(m.pattern)) body.reviewer = user?.name;
      }
      // `id` too: packages/training resolves the expert / reviewer from req.user.id — without it every
      // annotation / rewrite / review was recorded as "local-expert" even with auth on
      let out = await m.h({ params: m.params, query: url.searchParams, body, raw: req, res, user: user && { ...user, id: user.expertId } });
      // zero-retention analysis (D27) must not touch data/ at all — not even the audit log
      if (req.method === "POST" && m.pattern !== "/auth/login" && m.pattern !== "/scripts/analyze-ephemeral") {
        void identity.audit({ expertId: user?.expertId ?? "anonymous", action: auditAction(m.pattern), target: Object.values(m.params)[0], detail: auditDetail(body) }).catch(() => {});
      }
      if (out === HANDLED) return;
      // rewrites store the submitter / reviewer as a user id: logged-in callers also get their names
      if (authEnabled() && user) out = withPeopleNames(m.pattern, out, (id) => identity.nameOf(id));
      // zero-retention analyses are counted in memory only (nothing written): include them in the quota shown
      if (authEnabled() && user && m.pattern === "/auth/me") out = withEphemeralUse(out, ephemeralToday.get(`${user.expertId}:${new Date().toISOString().slice(0, 10)}`) ?? 0);
      if (out === undefined) {
        res.writeHead(204).end();
        return;
      }
      return json(res, 200, out);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status >= 500) log(`[server] ${req.method} ${req.url} failed: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) return json(res, status, { error: (e as Error).message });
      res.end();
    }
  }) as App;
  server.tail = tail;
  server.data = data;
  server.arena = arena;
  server.router = router;
  server.ready = ready;
  server.identity = identity;
  server.stopIm = async () => {
    await im?.stop();
    im = undefined;
  };
  server.links = links;
  server.attestation = attestation;
  server.warm = async () => {
    await Promise.all([
      data.warm(),
      attestation.refresh().then(
        (a) => log(`[server] attestation ready (${a.recorded ? "recorded" : "live"}, verified=${a.verified})`),
        (e: Error) => log(`[server] attestation warm-up failed: ${e.message}`),
      ),
    ]);
  };
  server.on("close", () => {
    tail.close();
    data.stop();
    arena.stopAll();
    void im?.stop().catch(() => {});
  });
  return server;
}

/** Start @baitnet/im (backend C) with the real identity service, chat store and arena; failures only warn. */
async function startImBridge(o: {
  identity: IdentityStore;
  arena: ArenaManager;
  links: Links;
  log: (s: string) => void;
  registry: () => RegistryClient;
  imOptions?: AppOptions["imOptions"];
}) {
  try {
    const im = await import("@baitnet/im");
    const trainingMod = await import("@baitnet/training");
    const scriptlabMod = await import("@baitnet/scriptlab");
    const handle = await im.startIm({
      identity: o.identity,
      chats: o.identity.chats,
      arena: o.arena,
      training: trainingMod,
      scriptlab: im.scriptlabFromModules(scriptlabMod, { registry: o.registry(), log: o.log }),
      publicUrl: o.links.publicUrl ?? "",
      log: o.log,
      ...(o.imOptions ?? {}),
    });
    const bot = (handle as { bot?: { username?: string } }).bot?.username;
    if (bot && !o.links.telegramBot) o.links.telegramBot = bot;
    return handle;
  } catch (e) {
    o.log(`[server] WARNING: IM bridge not started: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Corrections keep `expertId` / `reviewer` as user ids (stable, renames-safe). For display the web needs
 * names, so GET /training/corrections and the review response gain `expertName` / `reviewerName`.
 * Only called for logged-in users (the route itself already needs a login), never for anonymous visitors.
 */
export function withPeopleNames(pattern: string, out: unknown, nameOf: (id: string) => string | undefined): unknown {
  type C = { expertId?: string; reviewer?: string };
  const named = (c: C) =>
    c && typeof c === "object"
      ? {
          ...c,
          ...(c.expertId && nameOf(c.expertId) ? { expertName: nameOf(c.expertId) } : {}),
          ...(c.reviewer && nameOf(c.reviewer) ? { reviewerName: nameOf(c.reviewer) } : {}),
        }
      : c;
  if (pattern === "/training/corrections") return Array.isArray(out) ? out.map(named) : out && typeof out === "object" && "expertId" in out ? named(out as C) : out;
  if (pattern === "/training/corrections/:id/review" && out && typeof out === "object" && "correction" in out)
    return { ...(out as object), correction: named((out as { correction: C }).correction) };
  return out;
}

/** /auth/me quota plus today's in-memory zero-retention analyses (same sum the ephemeral gate checks). */
export function withEphemeralUse(out: unknown, ephemeral: number): unknown {
  const q = (out as { llmQuota?: { usedToday: number; limitPerDay: number } } | undefined)?.llmQuota;
  if (!ephemeral || !q) return out;
  return { ...(out as object), llmQuota: { ...q, usedToday: Math.min(q.limitPerDay, q.usedToday + ephemeral) } };
}
