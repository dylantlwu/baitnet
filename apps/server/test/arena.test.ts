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
  it("D33: approving a draft with warnings needs confirmWarnings → 409 {error, code, warnings, codes}", async () => {
    const s = (await post("/arena/sessions", { scriptId: "pig-butchering-04", scammer: "human", bait: "human" })).body as ArenaSession;
    const addr = "0xebb538b6bc2c2261e0af131502f7911f638bd797";
    await post(`/arena/sessions/${s.id}/say`, { side: "scammer", text: "Wait, are you a bot?" });
    await post(`/arena/sessions/${s.id}/say`, { side: "bait", text: "lol no" });
    await post(`/arena/sessions/${s.id}/say`, { side: "scammer", text: `Send it via TRC20 to ${addr}` });
    const detail = (await get(`/arena/sessions/${s.id}`)) as ArenaSession;
    const idx = detail.drafts.findIndex((d) => d.address === addr);
    expect(detail.drafts[idx]!.warnings?.map((w) => w.code)).toEqual(["suspicion-before", "chain-mismatch"]);
    const no = await post(`/arena/sessions/${s.id}/review`, { draftIndex: idx, approve: true });
    expect(no.status).toBe(409);
    expect(no.body).toMatchObject({ code: "warnings-unconfirmed", codes: ["suspicion-before", "chain-mismatch"], warnings: detail.drafts[idx]!.warnings });
    expect(no.body.error).toMatch(/confirmWarnings/);
    const yes = await post(`/arena/sessions/${s.id}/review`, { draftIndex: idx, approve: true, confirmWarnings: true });
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ review: "approved", alertId: expect.any(Number) });
  });

  it("lists 30 scripts", async () => {
    const s = await get("/arena/scripts");
    expect(s.length).toBeGreaterThanOrEqual(30);
  });

  it("D30: GET /arena/models (offline → all unavailable), modelChoice on create/list/detail, bad value → 400", async () => {
    const m = await get("/arena/models");
    expect(m.default).toBe("deepseek");
    expect(m.liveLLM).toBe(false);
    expect(m.models.map((x: { id: string }) => x.id)).toEqual(["deepseek", "glm", "haiku", "sonnet"]);
    expect(m.models.every((x: { available: boolean }) => !x.available)).toBe(true);
    expect(m.models.find((x: { id: string }) => x.id === "sonnet")).toMatchObject({ tee: false, price: { input: 2, output: 10 } });

    const bad = await post("/arena/sessions", { scriptId: "fake-loan-02", modelChoice: "gpt-9" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/modelChoice/);

    const dflt = (await post("/arena/sessions", { scriptId: "fake-loan-02" })).body as ArenaSession;
    expect(dflt.modelChoice).toBe("deepseek");
    const g = (await post("/arena/sessions", { scriptId: "fake-loan-02", modelChoice: "glm" })).body as ArenaSession;
    expect(g).toMatchObject({ engine: "rules", modelChoice: "glm" });
    expect(g.model).toBeUndefined(); // offline = rules mode, no model
    expect((await get(`/arena/sessions/${g.id}`)).modelChoice).toBe("glm");
    expect((await get("/arena/sessions")).find((x: ArenaSession) => x.id === g.id)?.modelChoice).toBe("glm");
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

  it("say: human scammer → the AI decoy answers once by itself (typing on SSE); both human → no answer", async () => {
    const s = (await post("/arena/sessions", { scriptId: "fake-loan-02", scammer: "human", bait: "ai" })).body as ArenaSession;
    const ctrl = new AbortController();
    const res = await fetch(`${base}/arena/sessions/${s.id}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const seen: { type: string; on?: boolean; side?: string }[] = [];
    let buf = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
            buf = buf.slice(i + 2);
            if (line) seen.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const said = await post(`/arena/sessions/${s.id}/say`, { side: "scammer", text: "你好，你的贷款批下来了" });
    expect(said.body).toMatchObject({ side: "scammer", author: "human" });
    // an immediate "step" must not produce a second decoy line
    await post(`/arena/sessions/${s.id}/control`, { action: "step" });
    await app.arena.get(s.id)!.lastAutoReply;
    const d = (await get(`/arena/sessions/${s.id}`)) as ArenaSession;
    expect(d.turns.map((t) => `${t.side}:${t.author}`)).toEqual(["scammer:human", "bait:ai"]);
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await pump;
    expect(seen.filter((e) => e.type === "typing").map((e) => `${e.side}:${e.on}`)).toEqual(["bait:true", "bait:false"]);

    const both = (await post("/arena/sessions", { scriptId: "fake-loan-02", scammer: "human", bait: "human" })).body as ArenaSession;
    await post(`/arena/sessions/${both.id}/say`, { side: "scammer", text: "你好" });
    await app.arena.get(both.id)!.lastAutoReply;
    expect(((await get(`/arena/sessions/${both.id}`)) as ArenaSession).turns).toHaveLength(1);
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

describe("D32 decoy mind over the API", () => {
  it("personaId optional on create (bad → 400); GET detail carries persona + decoyMind; /snapshot strips them", async () => {
    const bad = await post("/arena/sessions", { scriptId: "fake-loan-02", personaId: "nobody" });
    expect(bad.status).toBe(400);
    expect((await post("/arena/sessions", { scriptId: "fake-loan-02", personaId: 7 })).status).toBe(400);
    const s = (await post("/arena/sessions", { scriptId: "fake-loan-02", personaId: "zh-retired-teacher", scammer: "human", bait: "ai" })).body as ArenaSession;
    expect(s.persona).toMatchObject({ id: "zh-retired-teacher", name: "周建国" });
    const auto = (await post("/arena/sessions", { scriptId: "fake-loan-01" })).body as ArenaSession;
    expect(auto.persona!.lang).toBe("en");
    await post(`/arena/sessions/${s.id}/say`, { side: "scammer", text: "贷款批了，先交保证金到 0x602bb2c8cea0504ecf00523cf11f17886664ec82 ，网址 https://loan.example/x" });
    await app.arena.get(s.id)!.lastAutoReply;
    const d = (await get(`/arena/sessions/${s.id}`)) as ArenaSession;
    expect(d.persona!.id).toBe("zh-retired-teacher");
    expect(d.decoyMind).toMatchObject({ personaId: "zh-retired-teacher", intel: { address: "0x602bb2c8cea0504ecf00523cf11f17886664ec82", url: "https://loan.example/x" } });
    const snap = (await get("/snapshot")) as DemoSnapshot;
    const inSnap = snap.arenaSessions!.find((x) => x.id === s.id)!;
    expect(inSnap.turns.length).toBe(2);
    expect(inSnap.persona).toBeUndefined();
    expect(inSnap.decoyMind).toBeUndefined();
    expect(inSnap.turns.some((t) => t.mind)).toBe(false);
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
