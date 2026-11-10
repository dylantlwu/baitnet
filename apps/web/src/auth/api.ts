import { API, type AuditEntry, type Invite, type Me, type Role, type User } from "@baitnet/shared";

/**
 * Auth + admin client (D20). Only meaningful when the backend runs with BAITNET_AUTH=on;
 * a backend without the routes (404 / unreachable) means "auth disabled", i.e. today's local behaviour.
 */
export type AuthState =
  | { kind: "disabled" } // local / snapshot: no login, everyone acts as a reviewer
  | { kind: "anonymous" } // auth on, not logged in
  | { kind: "user"; me: Me };

export interface AdminApi {
  me(): Promise<AuthState>;
  login(code: string): Promise<Me>;
  logout(): Promise<void>;
  listInvites(): Promise<InviteRow[]>;
  createInvite(name: string, role: Role): Promise<Invite>;
  /** By the user id from listInvites() (or a full, unmasked code). The masked code in the list does not work. */
  revokeInvite(userIdOrCode: string): Promise<void>;
  listUsers(): Promise<User[]>;
  listAudit(): Promise<AuditEntry[]>;
}

/** An invite as listed (GET /admin/invites): the code is masked ("AB…GJ"); `id` is the invited user's id. */
export type InviteRow = Invite & { id?: string };

/** What to send to revoke a listed invite: the user id. The masked code alone cannot be revoked. */
export const revokeKey = (inv: InviteRow): string | null => inv.id ?? (/[…•]/.test(inv.code) ? null : inv.code);

export class AuthError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

/** Not in the shared API constants yet; members list for the team page. */
export const ADMIN_USERS = "/admin/users";

const arr = <T>(v: unknown, key: string): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key])) return (v as Record<string, T[]>)[key];
  return [];
};

export function meToState(status: number, body: unknown): AuthState {
  if (status === 404) return { kind: "disabled" };
  if (status === 401 || status === 403) return { kind: "anonymous" };
  const me = body as Me | undefined;
  if (!me || typeof me !== "object") return { kind: "disabled" };
  if (!me.authEnabled) return { kind: "disabled" };
  if (!me.expertId) return { kind: "anonymous" };
  return { kind: "user", me };
}

export function createHttpAdmin(apiBase: string, fetchFn: typeof fetch = (...a) => fetch(...a)): AdminApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(apiBase + path, {
      method,
      credentials: "include",
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) throw new AuthError(res.status, (json as { error?: string } | undefined)?.error ?? (text || `HTTP ${res.status}`));
    return json as T;
  }
  return {
    async me() {
      try {
        const res = await fetchFn(apiBase + API.authMe, { credentials: "include", headers: { Accept: "application/json" } });
        const text = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          // SPA fallback HTML or empty: treat as no auth backend.
          return { kind: "disabled" };
        }
        return meToState(res.status, body);
      } catch {
        return { kind: "disabled" };
      }
    },
    login: (code) => call<Me>("POST", API.authLogin, { code: code.trim() }),
    logout: async () => {
      await call("POST", API.authLogout, {});
    },
    listInvites: async () => arr<InviteRow>(await call("GET", API.adminInvites), "invites"),
    createInvite: (name, role) => call<Invite>("POST", API.adminInvites, { name, role }),
    revokeInvite: async (code) => {
      await call("POST", API.adminInviteRevoke(encodeURIComponent(code)), {});
    },
    listUsers: async () => arr<User>(await call("GET", ADMIN_USERS), "users"),
    listAudit: async () => arr<AuditEntry>(await call("GET", API.adminAudit), "entries"),
  };
}

/** Web login link for an invite (backend may already provide one). */
export function loginUrlFor(inv: Invite, origin: string): string {
  return inv.loginUrl ?? `${origin}/#/login?code=${encodeURIComponent(inv.code)}`;
}

/**
 * In-browser auth mock (?auth=mock) so the login / team pages can be developed and screenshotted
 * before the backend ships them. Codes: DEMO-REVIEW (reviewer), DEMO-EXPERT (expert).
 */
export function createMockAdmin(opts: { loggedInAs?: Role } = {}): AdminApi {
  const now = () => new Date().toISOString();
  const users: User[] = [
    { id: "u-dylan", name: "Dylan", role: "reviewer", createdAt: "2026-11-09T02:00:00.000Z", bindings: [{ kind: "telegram", externalId: "100200300", username: "dylan_bn", boundAt: "2026-11-09T02:05:00.000Z" }] },
    { id: "u-zhou", name: "老周", role: "expert", createdAt: "2026-11-09T03:00:00.000Z", bindings: [{ kind: "telegram", externalId: "100200301", username: "laozhou", boundAt: "2026-11-09T03:02:00.000Z" }, { kind: "lark", externalId: "ou_7f3a91", boundAt: "2026-11-09T05:40:00.000Z" }] },
    { id: "u-mia", name: "Mia", role: "expert", createdAt: "2026-11-09T04:00:00.000Z", bindings: [{ kind: "lark", externalId: "ou_2b8c11", boundAt: "2026-11-09T04:10:00.000Z" }] },
    { id: "u-chen", name: "陈晨", role: "expert", createdAt: "2026-11-09T06:00:00.000Z", bindings: [] },
  ];
  const invites: InviteRow[] = [
    { id: "u-zhou", code: "H4…2K", name: "老周", role: "expert", createdBy: "Dylan", createdAt: "2026-11-09T02:58:00.000Z", usedAt: "2026-11-09T03:00:00.000Z" },
    { id: "u-chen", code: "M4…XA", name: "陈晨", role: "expert", createdBy: "Dylan", createdAt: "2026-11-09T05:58:00.000Z" },
    { id: "u-tmp", code: "P9…DW", name: "临时测试", role: "expert", createdBy: "Dylan", createdAt: "2026-11-09T01:00:00.000Z", revoked: true },
  ];
  const audit: AuditEntry[] = [
    { at: "2026-11-09T07:41:00.000Z", expertId: "u-zhou", action: "arena.say", target: "as-rec-pig-zh" },
    { at: "2026-11-09T07:52:00.000Z", expertId: "u-dylan", action: "alert.review", target: "as-rec-pig-zh#0", detail: "approved → alert #2" },
    { at: "2026-11-09T08:31:00.000Z", expertId: "u-zhou", action: "training.correction", target: "cor-202" },
    { at: "2026-11-09T08:50:00.000Z", expertId: "u-mia", action: "scripts.upload", target: "wa-chat-2026-11.txt" },
  ];
  const meFor = (role: Role): Me =>
    role === "reviewer"
      ? { authEnabled: true, expertId: "u-dylan", name: "Dylan", role, llmQuota: { usedToday: 37, limitPerDay: 300 } }
      : { authEnabled: true, expertId: "u-zhou", name: "老周", role, llmQuota: { usedToday: 12, limitPerDay: 100 } };
  let me: Me | null = opts.loggedInAs ? meFor(opts.loggedInAs) : null;
  const mustReview = () => {
    if (!me) throw new AuthError(401, "not logged in");
    if (me.role !== "reviewer") throw new AuthError(403, "reviewer only");
  };
  let n = 0;
  return {
    me: async () => (me ? { kind: "user", me } : { kind: "anonymous" }),
    async login(code) {
      const c = code.trim().toUpperCase();
      if (c === "DEMO-REVIEW") me = meFor("reviewer");
      else if (c === "DEMO-EXPERT") me = meFor("expert");
      else throw new AuthError(401, "invalid or revoked code");
      return me;
    },
    async logout() {
      me = null;
    },
    async listInvites() {
      mustReview();
      return invites.map((i) => ({ ...i }));
    },
    async createInvite(name, role) {
      mustReview();
      // same shape as the server: 12 characters, no look-alikes (0/O, 1/I/L)
      const abc = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
      const code = Array.from({ length: 12 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
      const id = `u-${++n}`;
      const inv: Invite = {
        code, name, role, createdBy: me!.name, createdAt: now(),
        telegramStartUrl: `https://t.me/BaitNetTrainerBot?start=${code}`,
      };
      invites.unshift({ ...inv, id, code: `${code.slice(0, 2)}…${code.slice(-2)}` });
      users.push({ id, name, role, createdAt: now(), bindings: [] });
      audit.unshift({ at: now(), expertId: me!.expertId, action: "admin.invite", target: name, detail: role });
      return inv;
    },
    async revokeInvite(idOrCode) {
      mustReview();
      // like the server: a user id (what the list gives) or a full code; a masked "AB…GJ" matches nothing
      const i = invites.find((x) => x.id === idOrCode);
      if (!i) throw new AuthError(404, "invite not found");
      i.revoked = true;
      audit.unshift({ at: now(), expertId: me!.expertId, action: "admin.revoke", target: idOrCode });
    },
    async listUsers() {
      mustReview();
      return users.map((u) => ({ ...u }));
    },
    async listAudit() {
      mustReview();
      return audit.map((a) => ({ ...a }));
    },
  };
}
