import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataPath, REPO_ROOT } from "@baitnet/agent";
import { createApp, type App } from "../src/app.js";

/** path → size + sha256 of every file under data/ (mtime-independent but content-exact). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

let app: App;
let base = "";
beforeAll(async () => {
  process.env.BAITNET_REGISTRY = "memory";
  process.env.BAITNET_MODE = "offline";
  app = createApp({ log: () => {}, startIm: false });
  await app.ready;
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("POST /scripts/analyze-ephemeral（D27，server 层）", () => {
  it.each([
    ["zh-pig-butchering.txt", "zh"],
    ["en-telegram-export.json", "en"],
  ])("%s：离线返回录制的 attestation（M10 已接上），data 目录没有任何变化", async (file, lang) => {
    // warm up anything the server lazily creates (training db etc.) so the snapshot is stable
    await fetch(base + "/health");
    const before = snapshot(dataPath());
    const content = readFileSync(join(REPO_ROOT, "fixtures", "training", "samples", file), "utf8");
    const r = await fetch(base + "/scripts/analyze-ephemeral", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": lang === "zh" ? "zh-CN" : "en-US" },
      body: JSON.stringify({ filename: file, content, encoding: "utf8", expertId: "local-expert" }),
    });
    expect(r.status).toBe(200);
    const a = await r.json();
    expect(a.ephemeral).toBe(true);
    expect(a.attestation).toMatchObject({ recorded: true, verified: true });
    expect(a.attestation.checks.length).toBeGreaterThan(10);
    expect(a.attestation.checks.some((c: { detail: string }) => /not wired/.test(c.detail))).toBe(false);
    expect(snapshot(dataPath())).toEqual(before);
  });
});

describe("零留存端点的额度和限流（BAITNET_AUTH=on，内存计数）", () => {
  let app2: App;
  let b2 = "";
  const prev = { auth: process.env.BAITNET_AUTH, lim: process.env.BAITNET_LLM_DAILY_LIMIT };
  beforeAll(async () => {
    process.env.BAITNET_AUTH = "on";
    process.env.BAITNET_LLM_DAILY_LIMIT = "3";
    app2 = createApp({ log: () => {}, startIm: false });
    await app2.ready;
    await new Promise<void>((r) => app2.listen(0, r));
    b2 = `http://127.0.0.1:${(app2.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    process.env.BAITNET_AUTH = prev.auth;
    process.env.BAITNET_LLM_DAILY_LIMIT = prev.lim;
    await new Promise<void>((r) => app2.close(() => r()));
  });
  const content = readFileSync(join(REPO_ROOT, "fixtures", "training", "samples", "zh-pig-butchering.txt"), "utf8");
  const login = async (code: string) =>
    (await fetch(b2 + "/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": code }, body: JSON.stringify({ code }) })).headers.get("set-cookie")!.split(";")[0]!;
  const analyze = (cookie?: string) =>
    fetch(b2 + "/scripts/analyze-ephemeral", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ filename: "a.txt", content, encoding: "utf8", expertId: "x" }),
    });

  it("未登录 401", async () => {
    expect((await analyze()).status).toBe(401);
  });

  it("已持久化的额度 + 内存计数合并判断，超额 429；data 目录没有任何变化", async () => {
    const inv = app2.identity.createInvite("小王", "expert", "t");
    await app2.identity.consumeLlmQuota(inv.userId); // 1 of 3 already used (persisted, e.g. arena)
    const cookie = await login(inv.code);
    const before = snapshot(dataPath());
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await analyze(cookie)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
    const r = await analyze(cookie);
    expect(await r.json()).toMatchObject({ error: "daily LLM quota used up" });
    expect(snapshot(dataPath())).toEqual(before);
  });

  it("每人每分钟最多 5 次", async () => {
    process.env.BAITNET_LLM_DAILY_LIMIT = "300";
    const inv = app2.identity.createInvite("小李", "expert", "t");
    const cookie = await login(inv.code);
    const before = snapshot(dataPath());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await analyze(cookie)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(snapshot(dataPath())).toEqual(before);
    // another person is not affected
    const other = await login(app2.identity.createInvite("小赵", "expert", "t").code);
    expect((await analyze(other)).status).toBe(200);
  });
});
