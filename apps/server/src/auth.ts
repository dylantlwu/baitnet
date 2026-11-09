import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditEntry, ChannelKind, IdentityBinding, Invite, Me, Role, User } from "@baitnet/shared";

/**
 * Identity service (D20 + docs/dev/im-contract.md): users, invites, IM bindings,
 * roles, daily LLM quota, audit log, web sessions, IM chat→session map.
 * One SQLite file: data/auth.sqlite. Codes and session tokens are stored as sha256 only.
 *
 * - Web login (cookie) is enforced only when BAITNET_AUTH=on.
 * - IM whitelisting works whenever an IM adapter runs (independent of BAITNET_AUTH).
 */

export const authEnabled = (env: NodeJS.ProcessEnv = process.env) => env.BAITNET_AUTH === "on";
export const llmDailyLimit = (env: NodeJS.ProcessEnv = process.env) => Number(env.BAITNET_LLM_DAILY_LIMIT ?? 300) || 300;

export const COOKIE = "baitnet_session";
export const SESSION_DAYS = 30;
/** No 0/O, 1/I/L — easy to read from a phone screen. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LEN = 12;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[\s-]/g, "");

export function generateCode(len = CODE_LEN): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export interface Identity {
  expertId: string;
  name: string;
  role: Role;
}

/** When web auth is off everyone is an implicit local reviewer (unchanged local demo behaviour). */
export const LOCAL_IDENTITY: Identity = { expertId: "local-expert", name: "local", role: "reviewer" };

type ImKind = Exclude<ChannelKind, "web">;

/** Contract types (docs/dev/im-contract.md). */
export interface IdentityService {
  bindByCode(kind: ImKind, externalId: string, username: string | undefined, code: string): Promise<User | null>;
  userByBinding(kind: ImKind, externalId: string): Promise<User | null>;
  reviewers(kind: ImKind): Promise<{ user: User; externalId: string }[]>;
  consumeLlmQuota(userId: string): Promise<boolean>;
  audit(entry: Omit<AuditEntry, "at">): Promise<void>;
}
export interface ChatSessionStore {
  get(kind: ChannelKind, chatId: string): Promise<string | undefined>;
  set(kind: ChannelKind, chatId: string, sessionId: string): Promise<void>;
  clear(kind: ChannelKind, chatId: string): Promise<void>;
}

export interface Links {
  publicUrl?: string;
  telegramBot?: string;
}

export class IdentityStore implements IdentityService {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private opts: { now?: () => Date; dailyLimit?: number } = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY, code_hint TEXT NOT NULL, user_id TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS identity_bindings (
        kind TEXT NOT NULL, external_id TEXT NOT NULL, username TEXT, user_id TEXT NOT NULL, bound_at TEXT NOT NULL,
        PRIMARY KEY (kind, external_id));
      CREATE TABLE IF NOT EXISTS web_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, expert_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
      CREATE TABLE IF NOT EXISTS llm_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (user_id, day));
      CREATE TABLE IF NOT EXISTS chat_sessions (kind TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, chat_id));
    `);
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }
  private iso() {
    return this.now().toISOString();
  }
  get dailyLimit() {
    return this.opts.dailyLimit ?? llmDailyLimit();
  }

  // ------------------------------------------------------------------ users / invites
  private user(id: string): User | null {
    const u = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    if (!u || u.revoked) return null;
    const bindings = (this.db.prepare("SELECT * FROM identity_bindings WHERE user_id = ? ORDER BY bound_at").all(id) as any[]).map(
      (b): IdentityBinding => ({ kind: b.kind, externalId: b.external_id, ...(b.username ? { username: b.username } : {}), boundAt: b.bound_at }),
    );
    return { id: u.id, name: u.name, role: u.role, bindings, createdAt: u.created_at };
  }

  /** New person + invite. The plain code is only returned here. */
  createInvite(name: string, role: Role, createdBy: string, links: Links = {}): Invite & { userId: string } {
    if (!name?.trim()) throw Object.assign(new Error("name required"), { status: 400 });
    if (role !== "expert" && role !== "reviewer") throw Object.assign(new Error("role must be expert|reviewer"), { status: 400 });
    const code = generateCode();
    const userId = `u_${randomBytes(5).toString("hex")}`;
    const at = this.iso();
    this.db.prepare("INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)").run(userId, name.trim(), role, at);
    this.db.prepare("INSERT INTO invites (code_hash, code_hint, user_id, created_by, created_at) VALUES (?,?,?,?,?)").run(sha(code), `${code.slice(0, 2)}…${code.slice(-2)}`, userId, createdBy, at);
    return { userId, code, name: name.trim(), role, createdBy, createdAt: at, ...inviteLinks(code, links) };
  }

  /** Masked codes; `id` (= user id) can be used to revoke. */
  listInvites(): (Invite & { id: string; bindings: IdentityBinding[] })[] {
    return (this.db.prepare("SELECT i.*, u.name, u.role, u.revoked AS user_revoked FROM invites i JOIN users u ON u.id = i.user_id ORDER BY i.created_at").all() as any[]).map((r) => ({
      id: r.user_id,
      code: r.code_hint,
      name: r.name,
      role: r.role,
      createdBy: r.created_by,
      createdAt: r.created_at,
      ...(r.used_at ? { usedAt: r.used_at } : {}),
      ...(r.revoked || r.user_revoked ? { revoked: true } : {}),
      bindings: (this.db.prepare("SELECT * FROM identity_bindings WHERE user_id = ?").all(r.user_id) as any[]).map((b) => ({ kind: b.kind, externalId: b.external_id, username: b.username ?? undefined, boundAt: b.bound_at })),
    }));
  }

  /** Revoke by full code or user id: web sessions and IM bindings stop working immediately. */
  revoke(codeOrUserId: string): boolean {
    const inv = this.db.prepare("SELECT user_id FROM invites WHERE code_hash = ?").get(sha(normalizeCode(codeOrUserId))) as any;
    const userId = inv?.user_id ?? ((this.db.prepare("SELECT id FROM users WHERE id = ?").get(codeOrUserId) as any)?.id as string | undefined);
    if (!userId) return false;
    this.db.prepare("UPDATE invites SET revoked = 1 WHERE user_id = ?").run(userId);
    this.db.prepare("UPDATE users SET revoked = 1 WHERE id = ?").run(userId);
    this.db.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(userId);
    return true;
  }

  private userByCode(code: string): User | null {
    const inv = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(sha(normalizeCode(code))) as any;
    if (!inv || inv.revoked) return null;
    if (!inv.used_at) this.db.prepare("UPDATE invites SET used_at = ? WHERE code_hash = ?").run(this.iso(), inv.code_hash);
    return this.user(inv.user_id);
  }

  listUsers(): User[] {
    return (this.db.prepare("SELECT id FROM users WHERE revoked = 0 ORDER BY created_at").all() as any[]).map((r) => this.user(r.id)!).filter(Boolean);
  }

  // ------------------------------------------------------------------ IdentityService (IM)
  async bindByCode(kind: ImKind, externalId: string, username: string | undefined, code: string): Promise<User | null> {
    const u = this.userByCode(code);
    if (!u) return null;
    this.db
      .prepare("INSERT INTO identity_bindings (kind, external_id, username, user_id, bound_at) VALUES (?,?,?,?,?) ON CONFLICT(kind, external_id) DO UPDATE SET username = excluded.username, user_id = excluded.user_id")
      .run(kind, String(externalId), username ?? null, u.id, this.iso());
    return this.user(u.id);
  }

  async userByBinding(kind: ImKind, externalId: string): Promise<User | null> {
    const b = this.db.prepare("SELECT user_id FROM identity_bindings WHERE kind = ? AND external_id = ?").get(kind, String(externalId)) as any;
    return b ? this.user(b.user_id) : null;
  }

  async reviewers(kind: ImKind): Promise<{ user: User; externalId: string }[]> {
    const rows = this.db
      .prepare("SELECT b.user_id, b.external_id FROM identity_bindings b JOIN users u ON u.id = b.user_id WHERE b.kind = ? AND u.role = 'reviewer' AND u.revoked = 0")
      .all(kind) as any[];
    return rows.map((r) => ({ user: this.user(r.user_id)!, externalId: r.external_id }));
  }

  usedToday(userId: string): number {
    return ((this.db.prepare("SELECT count FROM llm_usage WHERE user_id = ? AND day = ?").get(userId, this.iso().slice(0, 10)) as any)?.count as number) ?? 0;
  }

  /** For IM /status. */
  async quota(userId: string): Promise<{ usedToday: number; limitPerDay: number }> {
    return { usedToday: this.usedToday(userId), limitPerDay: this.dailyLimit };
  }

  async consumeLlmQuota(userId: string): Promise<boolean> {
    if (this.usedToday(userId) >= this.dailyLimit) return false;
    this.db.prepare("INSERT INTO llm_usage (user_id, day, count) VALUES (?,?,1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1").run(userId, this.iso().slice(0, 10));
    return true;
  }

  async audit(e: Omit<AuditEntry, "at">): Promise<void> {
    this.db.prepare("INSERT INTO audit (at, expert_id, action, target, detail) VALUES (?,?,?,?,?)").run(this.iso(), e.expertId, e.action, e.target ?? null, e.detail ?? null);
  }

  listAudit(q: { expertId?: string; action?: string; limit?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.expertId) (where.push("expert_id = ?"), args.push(q.expertId));
    if (q.action) (where.push("action LIKE ?"), args.push(`${q.action}%`));
    args.push(Math.min(q.limit ?? 200, 2000));
    return (this.db.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args) as any[]).map((r) => ({
      at: r.at,
      expertId: r.expert_id,
      action: r.action,
      ...(r.target ? { target: r.target } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
    }));
  }

  // ------------------------------------------------------------------ web login
  login(code: string): { token: string; identity: Identity; expiresAt: string } | null {
    const u = this.userByCode(code);
    if (!u) return null;
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(sha(token), u.id, now.toISOString(), expiresAt);
    return { token, identity: { expertId: u.id, name: u.name, role: u.role }, expiresAt };
  }

  logout(token: string) {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha(token));
  }

  identify(token: string | undefined): Identity | null {
    if (!token) return null;
    const s = this.db.prepare("SELECT user_id, expires_at FROM web_sessions WHERE token_hash = ?").get(sha(token)) as any;
    if (!s || s.expires_at < this.iso()) return null;
    const u = this.user(s.user_id);
    return u ? { expertId: u.id, name: u.name, role: u.role } : null;
  }

  me(id: Identity, enabled = true): Me {
    return { authEnabled: enabled, expertId: id.expertId, name: id.name, role: id.role, llmQuota: { usedToday: this.usedToday(id.expertId), limitPerDay: this.dailyLimit } };
  }

  // ------------------------------------------------------------------ chat → session
  readonly chats: ChatSessionStore = {
    get: async (kind, chatId) => ((this.db.prepare("SELECT session_id FROM chat_sessions WHERE kind = ? AND chat_id = ?").get(kind, String(chatId)) as any)?.session_id as string | undefined) ?? undefined,
    set: async (kind, chatId, sessionId) => {
      this.db
        .prepare("INSERT INTO chat_sessions (kind, chat_id, session_id, updated_at) VALUES (?,?,?,?) ON CONFLICT(kind, chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at")
        .run(kind, String(chatId), sessionId, this.iso());
    },
    clear: async (kind, chatId) => {
      this.db.prepare("DELETE FROM chat_sessions WHERE kind = ? AND chat_id = ?").run(kind, String(chatId));
    },
  };

  close() {
    this.db.close();
  }
}

export function inviteLinks(code: string, links: Links): Pick<Invite, "loginUrl" | "telegramStartUrl"> {
  return {
    ...(links.publicUrl ? { loginUrl: `${links.publicUrl.replace(/\/+$/, "")}/#/login?code=${encodeURIComponent(code)}` } : {}),
    ...(links.telegramBot ? { telegramStartUrl: `https://t.me/${links.telegramBot.replace(/^@/, "")}?start=${encodeURIComponent(code)}` } : {}),
  };
}

/** Bot username: TELEGRAM_BOT_USERNAME, else Bot API getMe (only when a token is configured). */
export async function telegramBotUsername(env: NodeJS.ProcessEnv = process.env, f: typeof fetch = fetch): Promise<string | undefined> {
  if (env.TELEGRAM_BOT_USERNAME) return env.TELEGRAM_BOT_USERNAME.replace(/^@/, "");
  if (!env.TELEGRAM_BOT_TOKEN) return undefined;
  try {
    const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { ok?: boolean; result?: { username?: string } };
    return j.ok ? j.result?.username : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ cookies / request helpers
export function readCookie(req: IncomingMessage, name = COOKIE): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
export function isHttps(req: IncomingMessage): boolean {
  return (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() === "https" || !!(req.socket as { encrypted?: boolean }).encrypted;
}
export function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 86400}`];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}
export function clearSessionCookie(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`);
}
export function clientIp(req: IncomingMessage): string {
  const xf = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim(); // behind Caddy
  return xf || req.socket.remoteAddress || "unknown";
}

/** Sliding-window limiter (in memory). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit = 10,
    private windowMs = 60_000,
    private now: () => number = () => Date.now(),
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    const ok = arr.length < this.limit;
    if (ok) arr.push(t);
    this.hits.set(key, arr);
    return ok;
  }
}

// ------------------------------------------------------------------ policy
export type Need = "public" | "expert" | "reviewer";
const PUBLIC_GET = [/^\/$/, /^\/health$/, /^\/auth\/me$/, /^\/alerts(\/|$)/, /^\/check$/, /^\/events$/, /^\/flows\//, /^\/responders$/, /^\/acks$/, /^\/attestation$/];
const REVIEWER = [/^\/training\/corrections\/:id\/review$/, /^\/arena\/sessions\/:id\/review$/, /^\/scripts\/analyses\/:id\/review$/, /^\/admin\//, /^\/eval\/run$/];

export function requiredRole(method: string, pattern: string): Need {
  if (pattern === "/auth/login" || pattern === "/auth/logout") return "public";
  if (REVIEWER.some((r) => r.test(pattern))) return "reviewer";
  if (method === "GET" && PUBLIC_GET.some((r) => r.test(pattern))) return "public";
  return "expert";
}

/** "POST /arena/sessions/:id/say" → "arena.sessions.say" */
export function auditAction(pattern: string): string {
  return pattern.split("/").filter((s) => s && !s.startsWith(":")).join(".") || "root";
}

const SECRET_KEYS = new Set(["code", "content", "privateKey", "token", "password"]);
export function auditDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) out[k] = typeof v === "string" ? `[${v.length} chars]` : "[redacted]";
    else if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (v && typeof v === "object") out[k] = "{…}";
  }
  const s = JSON.stringify(out);
  return s === "{}" ? undefined : s.slice(0, 1000);
}
