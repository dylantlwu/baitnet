import type { Role } from "@baitnet/shared";
import { runEval } from "@baitnet/arena";
import { HANDLED, httpError, type Router } from "./router.js";
import {
  LOCAL_IDENTITY,
  RateLimiter,
  authEnabled,
  clearSessionCookie,
  clientIp,
  readCookie,
  setSessionCookie,
  type IdentityStore,
  type Links,
} from "./auth.js";

/** /auth/*, /admin/*, /eval/run. Policy (who may call what) is enforced in app.ts. */
export function registerAuthRoutes(router: Router, ids: IdentityStore, links: () => Links, log: (s: string) => void) {
  const limiter = new RateLimiter(10, 60_000);

  // Auth on + no session -> 401 (the web client maps 401/403 to "anonymous"). Never report LOCAL_IDENTITY as logged in.
  router.get("/auth/me", ({ user }) => {
    if (!authEnabled()) return { ...ids.me(user ?? LOCAL_IDENTITY, false), authEnabled: false };
    if (!user) throw httpError(401, "login required");
    return ids.me(user, true);
  });

  router.post("/auth/login", async ({ body, raw, res }) => {
    if (!limiter.allow(clientIp(raw))) throw httpError(429, "too many login attempts, try again in a minute");
    if (typeof body?.code !== "string") throw httpError(400, "code required");
    const r = ids.login(body.code);
    if (!r) {
      await ids.audit({ expertId: "anonymous", action: "auth.login.failed", detail: clientIp(raw) });
      throw httpError(401, "invalid or revoked invite code");
    }
    setSessionCookie(raw, res, r.token);
    await ids.audit({ expertId: r.identity.expertId, action: "auth.login" });
    return ids.me(r.identity, authEnabled());
  });

  router.post("/auth/logout", ({ raw, res }) => {
    const t = readCookie(raw);
    if (t) ids.logout(t);
    clearSessionCookie(raw, res);
    return { ok: true };
  });

  router.get("/admin/invites", () => ids.listInvites());
  router.post("/admin/invites", ({ body, user }) => {
    const role = (body?.role ?? "expert") as Role;
    return ids.createInvite(String(body?.name ?? ""), role, user?.name ?? "local", links());
  });
  router.post("/admin/invites/:code/revoke", ({ params }) => {
    if (!ids.revoke(params.code!)) throw httpError(404, "invite not found");
    return { ok: true };
  });
  router.get("/admin/users", () => ids.listUsers());
  router.get("/admin/audit", ({ query }) => ids.listAudit({ expertId: query.get("expertId") ?? undefined, action: query.get("action") ?? undefined, limit: Number(query.get("limit") ?? 200) }));

  let evalRunning = false;
  router.post("/eval/run", ({ body }) => {
    if (evalRunning) throw httpError(409, "eval already running");
    evalRunning = true;
    void runEval({ live: body?.live === true })
      .then((r) => log(`[eval] done: ${r.summary.extracted}/${r.summary.total} extracted (${r.engine})`))
      .catch((e) => log(`[eval] failed: ${(e as Error).message}`))
      .finally(() => (evalRunning = false));
    return { started: true };
  });
  return HANDLED;
}
