import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArenaEvent, ArenaSession, DemoSnapshot } from "@baitnet/shared";
import { createApp, type App } from "../src/app.js";

let app: App;
let base = "";
beforeAll(async () => {
  process.env.BAITNET_REGISTRY = "memory";
  process.env.BAITNET_MODE = "offline";
  process.env.ARENA_STEP_MS = "0";
  app = createApp({ log: () => {}, attestation: async () => ({ model: "m", nonce: "n", checks: [], verified: true, recorded: true, at: "x" }) });
  await app.ready;
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? undefined : await r.json(), cors: r.headers.get("access-control-allow-origin") };
};
const get = async (p: string) => (await fetch(base + p)).json();

describe("Arena API", () => {
  it("lists 30 scripts", async () => {
    const s = await get("/arena/scripts");
    expect(s.length).toBeGreaterThanOrEqual(30);
  });

  it("选剧本 → 单步 → 人接管骗子 → 抽地址 → 复核上链 → /check 拦截（含 SSE）", async () => {
    const created = await post("/arena/sessions", { scriptId: "fake-loan-02", scammer: "ai", bait: "ai" });
    expect(created.cors).toBe("http://localhost:5173");
    const s = created.body as ArenaSession;
    expect(s.engine).toBe("rules");
    // subscribe SSE
    const ctrl = new AbortController();
    const res = await fetch(`${base}/arena/sessions/${s.id}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const events: ArenaEvent[] = [];
    let buf = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    await post(`/arena/sessions/${s.id}/control`, { action: "step" });
    await post(`/arena/sessions/${s.id}/control`, { action: "step" });
    const addr = "TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE";
    const said = await post(`/arena/sessions/${s.id}/say`, { side: "scammer", text: `解冻金转这里：${addr}（波场）` });
    expect(said.body).toMatchObject({ side: "scammer", author: "human" });
    const detail = (await get(`/arena/sessions/${s.id}`)) as ArenaSession;
    expect(detail.modes.scammer).toBe("human");
    const idx = detail.drafts.findIndex((d) => d.address === addr);
    expect(detail.drafts[idx]!.review).toBe("pending");
    const rv = await post(`/arena/sessions/${s.id}/review`, { draftIndex: idx, approve: true });
    expect(rv.body).toMatchObject({ review: "approved", alertId: expect.any(Number) });
    expect((await get(`/check?chain=tron&address=${addr}`)).kind).toBe("block");
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    await pump;
    const types = events.map((e) => e.type);
    expect(types).toContain("turn");
    expect(types).toContain("mode");
    expect(types).toContain("draft");
    expect(types).toContain("onchain");
  });

  it("whisper / mode / validation errors", async () => {
    const s = (await post("/arena/sessions", { scriptId: "investment-01" })).body as ArenaSession;
    const w = await post(`/arena/sessions/${s.id}/whisper`, { side: "bait", text: "问问是不是 TRC20" });
    expect(w.body.modes.bait).toBe("ai+whisper");
    const m = await post(`/arena/sessions/${s.id}/mode`, { side: "bait", mode: "human" });
    expect(m.body.modes.bait).toBe("human");
    expect((await post(`/arena/sessions/${s.id}/whisper`, { side: "bait", text: "x" })).status).toBe(409);
    expect((await post(`/arena/sessions/${s.id}/mode`, { side: "nobody", mode: "ai" })).status).toBe(400);
    expect((await post("/arena/sessions", { scriptId: "nope" })).status).toBe(404);
    expect((await post(`/arena/sessions/${s.id}/control`, { action: "fly" })).status).toBe(400);
  });

  it("run 自动跑完整场", async () => {
    const s = (await post("/arena/sessions", { scriptId: "task-scam-03" })).body as ArenaSession;
    await post(`/arena/sessions/${s.id}/control`, { action: "run" });
    await app.arena.get(s.id)!.idle();
    const d = (await get(`/arena/sessions/${s.id}`)) as ArenaSession;
    expect(d.status).toBe("finished");
    expect(d.drafts.length).toBeGreaterThan(0);
  });

  it("/snapshot 带 arenaSessions；/eval/latest 没报告时 404", async () => {
    const snap = (await get("/snapshot")) as DemoSnapshot;
    expect(snap.arenaSessions!.length).toBeGreaterThanOrEqual(3);
    expect((await fetch(base + "/eval/latest")).status).toBe(404);
  });

  it("B2 training routes are mounted when the package exists", async () => {
    const r = await fetch(base + "/training/playbook");
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) expect(Array.isArray(await r.json())).toBe(true);
  });
});

describe("frontend follow-ups", () => {
  it("rate: validates and stores session.rating", async () => {
    const s = (await post("/arena/sessions", { scriptId: "fake-loan-01" })).body as ArenaSession;
    expect((await post(`/arena/sessions/${s.id}/rate`, { expertId: "e1", score: 9, note: "" })).status).toBe(400);
    const r = await post(`/arena/sessions/${s.id}/rate`, { expertId: "专家A", score: 4, note: "诱饵拖延得自然" });
    expect(r.body.rating).toMatchObject({ expertId: "专家A", score: 4, note: "诱饵拖延得自然", at: expect.any(String) });
    expect(((await get(`/arena/sessions/${s.id}`)) as ArenaSession).rating!.score).toBe(4);
    expect((await post(`/arena/sessions/nope/rate`, { expertId: "x", score: 3, note: "" })).status).toBe(404);
  });

  it("approved draft keeps txHash; safety events carry turnIndex; snapshot has arenaScripts", async () => {
    const s = (await post("/arena/sessions", { scriptId: "fake-loan-02", scammer: "human", bait: "ai" })).body as ArenaSession;
    await post(`/arena/sessions/${s.id}/say`, { side: "scammer", text: "转这里 0x602bb2c8cea0504ecf00523cf11f17886664ec82" });
    const rv = await post(`/arena/sessions/${s.id}/review`, { draftIndex: 0, approve: true });
    expect(rv.body.txHash).toMatch(/^mem-tx-/);
    expect(((await get(`/arena/sessions/${s.id}`)) as ArenaSession).drafts[0]!.txHash).toBe(rv.body.txHash);
    const snap = (await get("/snapshot")) as DemoSnapshot;
    expect(snap.arenaScripts!.length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(snap.arenaScripts![0]!).sort()).toEqual(["id", "lang", "title", "type"]);
  });
});
