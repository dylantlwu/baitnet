import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArenaSession } from "@baitnet/shared";
import { runEval } from "@baitnet/arena";
import { createApp, type App } from "../src/app.js";

const fakeAtt = async () => ({ model: "m", nonce: "n", checks: [], verified: true, recorded: true, at: "x" });
async function start(): Promise<{ app: App; base: string }> {
  const app = createApp({ log: () => {}, attestation: fakeAtt });
  await app.ready;
  await new Promise<void>((r) => app.listen(0, r));
  return { app, base: `http://127.0.0.1:${(app.address() as AddressInfo).port}` };
}
const stop = (app: App) => new Promise<void>((r) => app.close(() => r()));
const post = (base: string, p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const dist = mkdtempSync(join(tmpdir(), "baitnet-dist-"));
beforeAll(() => {
  process.env.BAITNET_REGISTRY = "memory";
  process.env.BAITNET_MODE = "offline";
  process.env.ARENA_STEP_MS = "0";
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>BaitNet</title>");
  writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)");
  process.env.BAITNET_WEB_DIST = dist;
});
afterAll(() => {
  delete process.env.BAITNET_WEB_DIST;
});

describe("会话列表 + 进程重启恢复（HTTP）", () => {
  it("重启后 ?mine=1 仍列出会话；进行中的恢复为 paused 并可继续 step / review", async () => {
    let { app, base } = await start();
    const s = (await post(base, "/arena/sessions", { scriptId: "fake-support-01" })) as ArenaSession;
    await post(base, `/arena/sessions/${s.id}/control`, { action: "step" });
    await post(base, `/arena/sessions/${s.id}/say`, { side: "scammer", text: "转到 TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE（波场）" });
    await stop(app);
    ({ app, base } = await start()); // simulated restart
    const list = (await (await fetch(`${base}/arena/sessions?mine=1`)).json()) as (ArenaSession & { live: boolean })[];
    const mine = list.find((x) => x.id === s.id)!;
    expect(mine).toMatchObject({ status: "paused", live: true });
    const step = await post(base, `/arena/sessions/${s.id}/control`, { action: "step" });
    expect(step.turns.length).toBe(3);
    const rv = await post(base, `/arena/sessions/${s.id}/review`, { draftIndex: 0, approve: true });
    expect(rv.review).toBe("approved");
    await stop(app);
  });
});

describe("部署形态", () => {
  let app: App;
  let base = "";
  beforeAll(async () => ({ app, base } = await start()));
  afterAll(() => stop(app));

  it("同一端口托管 apps/web/dist（SPA 回退 + 静态资源）", async () => {
    const root = await fetch(base + "/", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(await root.text()).toContain("<title>BaitNet</title>");
    expect(await (await fetch(base + "/")).json()).toMatchObject({ ok: true }); // API clients still get JSON
    const page = await fetch(base + "/arena");
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("<title>BaitNet</title>");
    const js = await fetch(base + "/assets/app-abc.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toMatch(/immutable/);
    expect((await fetch(base + "/assets/missing.js")).status).toBe(404);
    expect((await fetch(base + "/..%2f..%2fpackage.json")).status).not.toBe(200);
    expect((await fetch(base + "/alerts")).headers.get("content-type")).toMatch(/json/); // API still wins
  });

  it("SSE 带反向代理友好的头", async () => {
    const s = (await post(base, "/arena/sessions", { scriptId: "fake-loan-01" })) as ArenaSession;
    const ctrl = new AbortController();
    const r = await fetch(`${base}/arena/sessions/${s.id}/events`, { signal: ctrl.signal });
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    expect(r.headers.get("cache-control")).toMatch(/no-transform/);
    ctrl.abort();
  });

  it("/auth/me 在未启用登录时返回本地 reviewer", async () => {
    expect(await (await fetch(base + "/auth/me")).json()).toMatchObject({ authEnabled: false, role: "reviewer" });
  });

  it("/eval/latest 在规则模式下带 rulesModeCaveat", async () => {
    await runEval({ record: false, scripts: undefined, maxTurns: 6 });
    const r = await (await fetch(base + "/eval/latest")).json();
    expect(r.engine).toBe("rules");
    expect(r.rulesModeCaveat).toBe(true);
  });
});
