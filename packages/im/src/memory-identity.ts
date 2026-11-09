import type { AuditEntry, Role, User } from "@baitnet/shared";
import type { IdentityService, ImKind } from "./types.js";

/**
 * In-memory IdentityService for the standalone dev runner and tests.
 * Backend B's real one lives in apps/server (auth.sqlite); same contract.
 */
export class MemoryIdentityService implements IdentityService {
  private codes = new Map<string, { userId: string; revoked?: boolean }>();
  private users = new Map<string, User>();
  private usage = new Map<string, { day: string; n: number }>();
  readonly auditLog: AuditEntry[] = [];

  constructor(
    private opts: { llmDailyLimit?: number; now?: () => Date } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Register an invite; returns the user. */
  invite(code: string, name: string, role: Role, id = `u_${name.toLowerCase().replace(/\W+/g, "") || this.users.size}`): User {
    const user: User = this.users.get(id) ?? { id, name, role, bindings: [], createdAt: this.now().toISOString() };
    this.users.set(id, user);
    this.codes.set(code.toUpperCase(), { userId: id });
    return user;
  }

  revoke(code: string) {
    const c = this.codes.get(code.toUpperCase());
    if (c) c.revoked = true;
  }

  setLimit(n: number) {
    this.opts.llmDailyLimit = n;
  }

  async bindByCode(kind: ImKind, externalId: string, username: string | undefined, code: string): Promise<User | null> {
    const c = this.codes.get(code.trim().toUpperCase());
    if (!c || c.revoked) return null;
    const u = this.users.get(c.userId)!;
    // an IM account belongs to one user only
    for (const other of this.users.values()) other.bindings = other.bindings.filter((b) => !(b.kind === kind && b.externalId === externalId) || other === u);
    if (!u.bindings.some((b) => b.kind === kind && b.externalId === externalId)) u.bindings.push({ kind, externalId, username, boundAt: this.now().toISOString() });
    return u;
  }

  async userByBinding(kind: ImKind, externalId: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.bindings.some((b) => b.kind === kind && b.externalId === externalId)) return u;
    return null;
  }

  async reviewers(kind: ImKind) {
    const out: { user: User; externalId: string }[] = [];
    for (const u of this.users.values()) if (u.role === "reviewer") for (const b of u.bindings) if (b.kind === kind) out.push({ user: u, externalId: b.externalId });
    return out;
  }

  private day() {
    return this.now().toISOString().slice(0, 10);
  }

  async consumeLlmQuota(userId: string): Promise<boolean> {
    const limit = this.opts.llmDailyLimit ?? 300;
    const u = this.usage.get(userId);
    const cur = u && u.day === this.day() ? u : { day: this.day(), n: 0 };
    if (cur.n >= limit) return false;
    cur.n++;
    this.usage.set(userId, cur);
    return true;
  }

  async quota(userId: string) {
    const u = this.usage.get(userId);
    return { usedToday: u && u.day === this.day() ? u.n : 0, limitPerDay: this.opts.llmDailyLimit ?? 300 };
  }

  async audit(entry: Omit<AuditEntry, "at">): Promise<void> {
    this.auditLog.push({ ...entry, at: this.now().toISOString() });
  }
}
