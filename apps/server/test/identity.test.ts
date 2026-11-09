import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityStore, generateCode, telegramBotUsername, inviteLinks } from "../src/auth.js";
import { listenHost } from "../src/host.js";
import { createApp, type App } from "../src/app.js";

const links = { publicUrl: "https://baitnet.example", telegramBot: "BaitNetTrainerBot" };

describe("IdentityService", () => {
  it("邀请码：12 位、无易混字符；返回 loginUrl 和 telegramStartUrl", () => {
    const ids = new IdentityStore(":memory:");
    const inv = ids.createInvite("小王", "expert", "dylan", links);
    expect(inv.code).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    expect(inv.loginUrl).toBe(`https://baitnet.example/#/login?code=${inv.code}`);
    expect(inv.telegramStartUrl).toBe(`https://t.me/BaitNetTrainerBot?start=${inv.code}`);
    for (let i = 0; i < 50; i++) expect(generateCode()).not.toMatch(/[01OIL]/);
    // only the hash is stored
    expect(JSON.stringify(ids.db.prepare("SELECT * FROM invites").all())).not.toContain(inv.code);
    expect(ids.listInvites()[0]!.code).not.toBe(inv.code);
  });

  it("绑定：同一个码绑同一个人的多个 IM 账号；userByBinding；大小写和空格不敏感", async () => {
    const ids = new IdentityStore(":memory:");
    const inv = ids.createInvite("小王", "expert", "dylan");
    const u1 = await ids.bindByCode("telegram", "1001", "wang_tg", inv.code.toLowerCase());
    const u2 = await ids.bindByCode("lark", "ou_abc", undefined, inv.code.slice(0, 4) + " " + inv.code.slice(4));
    expect(u1!.id).toBe(u2!.id);
    expect(u2!.bindings.map((b) => b.kind).sort()).toEqual(["lark", "telegram"]);
    expect((await ids.userByBinding("telegram", "1001"))!.name).toBe("小王");
    expect(await ids.userByBinding("telegram", "9999")).toBeNull();
    expect(await ids.bindByCode("telegram", "2002", undefined, "WRONGCODE123")).toBeNull();
  });

  it("撤销后：IM 绑定和网页登录立即失效，码不能再用", async () => {
    const ids = new IdentityStore(":memory:");
    const inv = ids.createInvite("小李", "expert", "dylan");
    await ids.bindByCode("telegram", "3003", undefined, inv.code);
    const login = ids.login(inv.code)!;
    expect(ids.identify(login.token)!.name).toBe("小李");
    expect(ids.revoke(inv.code)).toBe(true);
    expect(await ids.userByBinding("telegram", "3003")).toBeNull();
    expect(ids.identify(login.token)).toBeNull();
    expect(ids.login(inv.code)).toBeNull();
    expect(await ids.bindByCode("telegram", "3004", undefined, inv.code)).toBeNull();
    expect(ids.listInvites()[0]!.revoked).toBe(true);
  });

  it("reviewers(kind)：只列出绑定了该渠道的 reviewer", async () => {
    const ids = new IdentityStore(":memory:");
    const r = ids.createInvite("Dylan", "reviewer", "cli");
    const e = ids.createInvite("小王", "expert", "dylan");
    const r2 = ids.createInvite("审核员2", "reviewer", "cli");
    await ids.bindByCode("telegram", "1", "dylan", r.code);
    await ids.bindByCode("telegram", "2", undefined, e.code);
    await ids.bindByCode("lark", "ou_r2", undefined, r2.code);
    const tg = await ids.reviewers("telegram");
    expect(tg.map((x) => [x.user.name, x.externalId])).toEqual([["Dylan", "1"]]);
    expect((await ids.reviewers("lark")).map((x) => x.user.name)).toEqual(["审核员2"]);
    ids.revoke(r.code);
    expect(await ids.reviewers("telegram")).toEqual([]);
  });

  it("每日额度：用完返回 false，第二天重置", async () => {
    let now = new Date("2026-11-10T08:00:00Z");
    const ids = new IdentityStore(":memory:", { now: () => now, dailyLimit: 2 });
    const u = ids.createInvite("小王", "expert", "x").userId;
    expect(await ids.consumeLlmQuota(u)).toBe(true);
    expect(await ids.consumeLlmQuota(u)).toBe(true);
    expect(await ids.consumeLlmQuota(u)).toBe(false);
    expect(ids.me({ expertId: u, name: "小王", role: "expert" }).llmQuota).toEqual({ usedToday: 2, limitPerDay: 2 });
    now = new Date("2026-11-11T00:00:01Z");
    expect(await ids.consumeLlmQuota(u)).toBe(true);
  });

  it("ChatSessionStore：SQLite 持久化，重开文件后还在；clear 生效", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "baitnet-auth-")), "auth.sqlite");
    const a = new IdentityStore(path);
    await a.chats.set("telegram", "chat-1", "arena-111");
    await a.chats.set("telegram", "chat-1", "arena-222"); // a new /new replaces it
    await a.chats.set("lark", "oc_1", "arena-333");
    await a.audit({ expertId: "u1", action: "arena.sessions.say", target: "arena-222" });
    a.close();
    const b = new IdentityStore(path);
    expect(await b.chats.get("telegram", "chat-1")).toBe("arena-222");
    expect(await b.chats.get("lark", "oc_1")).toBe("arena-333");
    await b.chats.clear("telegram", "chat-1");
    expect(await b.chats.get("telegram", "chat-1")).toBeUndefined();
    expect(b.listAudit()[0]).toMatchObject({ expertId: "u1", action: "arena.sessions.say" });
  });

  it("机器人用户名：环境变量优先，否则 getMe", async () => {
    expect(await telegramBotUsername({ TELEGRAM_BOT_USERNAME: "@MyBot" })).toBe("MyBot");
    const f = (async () => new Response(JSON.stringify({ ok: true, result: { username: "FromGetMe" } }))) as unknown as typeof fetch;
    expect(await telegramBotUsername({ TELEGRAM_BOT_TOKEN: "123:abc" }, f)).toBe("FromGetMe");
    expect(await telegramBotUsername({})).toBeUndefined();
    expect(inviteLinks("ABC", {})).toEqual({});
  });
});

describe("HOST 绑定", () => {
  it("生产默认 127.0.0.1，HOST 可覆盖，开发默认全部网卡", () => {
    expect(listenHost({ NODE_ENV: "production" })).toBe("127.0.0.1");
    expect(listenHost({ NODE_ENV: "production", HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(listenHost({})).toBeUndefined();
  });
  it("实际只在 127.0.0.1 上监听", async () => {
    const app = createApp({ log: () => {}, startIm: false });
    await app.ready;
    await new Promise<void>((r) => app.listen(0, listenHost({ NODE_ENV: "production" }), r));
    expect((app.address() as AddressInfo).address).toBe("127.0.0.1");
    await new Promise<void>((r) => app.close(() => r()));
  });
});

describe("网页鉴权（BAITNET_AUTH=on）", () => {
  let app: App;
  let base = "";
  let reviewerCode = "";
  let expertCode = "";
  const prev = process.env.BAITNET_AUTH;
  beforeAll(async () => {
    process.env.BAITNET_AUTH = "on";
    process.env.BAITNET_REGISTRY = "memory";
    process.env.BAITNET_MODE = "offline";
    process.env.ARENA_STEP_MS = "0";
    app = createApp({ log: () => {}, startIm: false, attestation: async () => ({ model: "m", nonce: "n", checks: [], verified: true, recorded: true, at: "x" }) });
    await app.ready;
    app.links.telegramBot = "BaitNetTrainerBot";
    reviewerCode = app.identity.createInvite("Dylan", "reviewer", "cli").code;
    expertCode = app.identity.createInvite("小王", "expert", "Dylan").code;
    await new Promise<void>((r) => app.listen(0, r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    process.env.BAITNET_AUTH = prev;
    await new Promise<void>((r) => app.close(() => r()));
  });
  const login = async (code: string, ip = "1.1.1.1") => {
    const r = await fetch(base + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ code }) });
    return { r, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]! };
  };
  const call = (p: string, cookie: string, body?: unknown) =>
    fetch(base + p, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("登录：设置 httpOnly + SameSite=Lax cookie；/auth/me 返回身份和额度；登出后失效", async () => {
    const { r, cookie } = await login(expertCode);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(r.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    expect(r.headers.get("set-cookie")).not.toMatch(/Secure/); // plain http in tests
    const me = await (await call("/auth/me", cookie)).json();
    expect(me).toMatchObject({ authEnabled: true, name: "小王", role: "expert", llmQuota: { usedToday: 0, limitPerDay: 300 } });
    await call("/auth/logout", cookie, {});
    expect((await call("/arena/scripts", cookie)).status).toBe(401);
  });

  it("没登录 401；expert 越权 403；reviewer 可以", async () => {
    expect((await fetch(base + "/arena/scripts")).status).toBe(401);
    expect((await fetch(base + "/alerts")).status).toBe(200); // public read
    const { cookie: e } = await login(expertCode);
    const s = await (await call("/arena/sessions", e, { scriptId: "fake-loan-02", scammer: "human", bait: "ai" })).json();
    await call(`/arena/sessions/${s.id}/say`, e, { side: "scammer", text: "转这里 TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE" });
    expect((await call(`/arena/sessions/${s.id}/review`, e, { draftIndex: 0, approve: true })).status).toBe(403);
    expect((await call("/admin/invites", e)).status).toBe(403);
    const { cookie: r } = await login(reviewerCode);
    expect((await call(`/arena/sessions/${s.id}/review`, r, { draftIndex: 0, approve: true })).status).toBe(200);
    const inv = await (await call("/admin/invites", r, { name: "新同事", role: "expert" })).json();
    expect(inv.telegramStartUrl).toBe(`https://t.me/BaitNetTrainerBot?start=${inv.code}`);
  });

  it("expertId 取自登录身份；?mine=1 只列自己的；审计记录写操作", async () => {
    const { cookie: e } = await login(expertCode);
    const s = await (await call("/arena/sessions", e, { scriptId: "investment-01" })).json();
    expect(s.channel).toMatchObject({ kind: "web", ownerId: expect.stringMatching(/^u_/) });
    const rated = await (await call(`/arena/sessions/${s.id}/rate`, e, { expertId: "冒充的人", score: 5, note: "" })).json();
    expect(rated.rating.expertId).toBe(s.channel.ownerId);
    const { cookie: r } = await login(reviewerCode);
    await call("/arena/sessions", r, { scriptId: "investment-02" });
    const mine = (await (await call("/arena/sessions?mine=1", e)).json()) as { channel?: { ownerId: string } }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.channel?.ownerId === s.channel.ownerId)).toBe(true);
    const audit = await (await call("/admin/audit?action=arena", r)).json();
    expect(audit.some((a: { action: string; expertId: string }) => a.action === "arena.sessions.rate" && a.expertId === s.channel.ownerId)).toBe(true);
  });

  it("撤销后立即 401；同一 IP 每分钟最多 10 次登录", async () => {
    const tmp = app.identity.createInvite("临时", "expert", "Dylan").code;
    const { cookie } = await login(tmp);
    expect((await call("/arena/scripts", cookie)).status).toBe(200);
    const { cookie: r } = await login(reviewerCode, "2.2.2.2");
    expect((await call(`/admin/invites/${tmp}/revoke`, r, {})).status).toBe(200);
    expect((await call("/arena/scripts", cookie)).status).toBe(401);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await login("WRONGWRONG22", "9.9.9.9")).r.status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("前端后台对接", () => {
  it("CORS 回显来源 + credentials；/arena/sessions 都带 channel；/admin/users 带 bindings", async () => {
    process.env.BAITNET_REGISTRY = "memory";
    const app = createApp({ log: () => {}, startIm: false });
    await app.ready;
    await new Promise<void>((r) => app.listen(0, r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const r = await fetch(base + "/arena/sessions", { headers: { origin: "http://127.0.0.1:5173" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await fetch(base + "/alerts", { headers: { origin: "http://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
    const { MemoryRegistryClient } = await import("@baitnet/guard");
    const e = await app.arena.create("investment-01"); // created without a channel (e.g. by eval code)
    void MemoryRegistryClient;
    const list = (await r.json()) as unknown[];
    void list;
    const all = (await (await fetch(base + "/arena/sessions")).json()) as { channel?: { kind: string } }[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((s) => s.channel?.kind)).toBe(true);
    expect((await (await fetch(`${base}/arena/sessions/${e.session.id}`)).json()).channel).toEqual({ kind: "web", ownerId: "local-expert" });
    const inv = app.identity.createInvite("小赵", "expert", "x");
    await app.identity.bindByCode("telegram", "555", "zhao", inv.code);
    const users = (await (await fetch(base + "/admin/users")).json()) as { name: string; bindings: { kind: string }[] }[];
    expect(users.find((u) => u.name === "小赵")!.bindings[0]!.kind).toBe("telegram");
    await new Promise<void>((res) => app.close(() => res()));
  });
});
