import type { ArenaSession, ArenaSide, SideMode } from "@baitnet/shared";
import { ArenaManager, ARENA_MODEL_IDS, isArenaModelChoice, langFromAcceptLanguage, readLatestReport } from "@baitnet/arena";
import { HANDLED, httpError, type Router } from "./router.js";
import { SSE_HEADERS } from "./static.js";

const SIDES: ArenaSide[] = ["scammer", "bait"];
/** Every session carries `channel` (older/eval sessions default to a local web session). */
const withChannel = <T extends ArenaSession>(s: T): T => (s.channel ? s : { ...s, channel: { kind: "web", ownerId: "local-expert" } });
const MODES: SideMode[] = ["ai", "human", "ai+whisper"];

function side(v: unknown): ArenaSide {
  if (!SIDES.includes(v as ArenaSide)) throw httpError(400, `side must be one of ${SIDES.join("|")}`);
  return v as ArenaSide;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw httpError(400, "text required");
  if (v.length > 4000) throw httpError(400, "text too long");
  return v;
}

/** §4 Arena API. */
export function registerArenaRoutes(router: Router, mgr: ArenaManager, o: { authEnabled?: () => boolean } = {}) {
  const authOn = () => o.authEnabled?.() ?? false;
  const live = (id: string) => {
    const e = mgr.get(id);
    if (!e) throw httpError(404, `session ${id} is not live (finished sessions are read-only)`);
    return e;
  };

  router.get("/arena/scripts", async ({ query }) => mgr.scripts(query.get("refresh") === "1"));

  // D30: models an expert can pick when starting a session (available=false → that session runs on rules)
  router.get("/arena/models", () => mgr.models());

  router.post("/arena/sessions/:id/rate", async ({ params, body, user }) => mgr.rate(params.id!, { ...(body ?? {}), ...(authOn() && user ? { expertId: user.expertId } : {}) }));

  // ?mine=1: the caller's live + finished sessions (no login yet → everyone's; newest first)
  router.get("/arena/sessions", ({ query, user }) => {
    const all = query.get("mine") === "1" && authOn() && user ? mgr.listByOwner(user.expertId) : mgr.list();
    const live = new Set(all.filter((s) => mgr.get(s.id)).map((s) => s.id));
    const out = all.map((s) => ({ ...withChannel(s), live: live.has(s.id) }));
    return query.get("mine") === "1" ? out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : out;
  });

  router.post("/arena/sessions", async ({ body, user }) => {
    const scriptId = body?.scriptId;
    if (typeof scriptId !== "string") throw httpError(400, "scriptId required");
    const modes: Partial<Record<ArenaSide, SideMode>> = {};
    for (const s of SIDES) {
      if (body?.[s] === undefined) continue;
      if (!MODES.includes(body[s])) throw httpError(400, `${s} mode must be ${MODES.join("|")}`);
      modes[s] = body[s];
    }
    const modelChoice = body?.modelChoice ?? undefined;
    if (modelChoice !== undefined && !isArenaModelChoice(modelChoice)) throw httpError(400, `modelChoice must be one of ${ARENA_MODEL_IDS.join("|")}`);
    const eng = await mgr.create(scriptId, modes, { kind: "web", ownerId: user?.expertId ?? "local-expert" }, modelChoice);
    return eng.session;
  });

  router.get("/arena/sessions/:id", ({ params }) => {
    const s = mgr.get(params.id!)?.session ?? mgr.list().find((x) => x.id === params.id);
    if (!s) throw httpError(404, "session not found");
    return withChannel(s);
  });

  router.get("/arena/sessions/:id/events", ({ params, raw, res }) => {
    const eng = live(params.id!);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders?.();
    res.write("retry: 3000\n: baitnet arena events\n\n");
    // replay current state so a late subscriber can render
    for (const turn of eng.session.turns) res.write(`data: ${JSON.stringify({ type: "turn", sessionId: eng.session.id, turn })}\n\n`);
    eng.session.drafts.forEach((draft, draftIndex) => res.write(`data: ${JSON.stringify({ type: "draft", sessionId: eng.session.id, draftIndex, draft })}\n\n`));
    const off = mgr.subscribe(eng.session.id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    raw.on("close", () => {
      clearInterval(ping);
      off();
    });
    return HANDLED;
  });

  router.post("/arena/sessions/:id/control", async ({ params, body }) => {
    const eng = live(params.id!);
    switch (body?.action) {
      case "run":
        void eng.run();
        break;
      case "pause":
        eng.pause();
        break;
      case "step":
        await eng.step();
        break;
      default:
        throw httpError(400, "action must be run|pause|step");
    }
    return eng.session;
  });

  router.post("/arena/sessions/:id/mode", ({ params, body }) => {
    const eng = live(params.id!);
    if (!MODES.includes(body?.mode)) throw httpError(400, `mode must be ${MODES.join("|")}`);
    eng.setMode(side(body?.side), body.mode);
    return eng.session;
  });

  router.post("/arena/sessions/:id/say", async ({ params, body }) => {
    const eng = live(params.id!);
    try {
      return await eng.say(side(body?.side), text(body?.text));
    } catch (e) {
      throw (e as { status?: number }).status ? e : httpError(409, (e as Error).message);
    }
  });

  router.post("/arena/sessions/:id/whisper", ({ params, body }) => {
    const eng = live(params.id!);
    try {
      eng.whisper(side(body?.side), text(body?.text));
    } catch (e) {
      throw (e as { status?: number }).status ? e : httpError(409, (e as Error).message);
    }
    return { ok: true, modes: eng.session.modes };
  });

  router.post("/arena/sessions/:id/review", async ({ params, body }) => {
    const eng = live(params.id!);
    if (typeof body?.draftIndex !== "number" || typeof body?.approve !== "boolean") throw httpError(400, "{draftIndex:number, approve:boolean} required");
    try {
      return await eng.review(body.draftIndex, body.approve, typeof body.reviewer === "string" ? body.reviewer : "operator");
    } catch (e) {
      throw (e as { status?: number }).status ? e : httpError(409, (e as Error).message);
    }
  });

  router.get("/eval/latest", ({ query, raw }) => {
    const q = query.get("lang");
    const r = readLatestReport(undefined, q === "en" || q === "zh" ? q : langFromAcceptLanguage(raw.headers["accept-language"]));
    if (!r) throw httpError(404, "no eval report yet — run: pnpm --filter @baitnet/arena run eval");
    return r;
  });
}
