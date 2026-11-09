import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DemoSnapshot, GuardEvent } from "@baitnet/shared";
import { fullDemo, makeCtx, ReplayProvider, appendEvent } from "@baitnet/agent";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let base = "";

beforeAll(async () => {
  process.env.BAITNET_REGISTRY = "memory";
  await fullDemo(makeCtx(() => {}), { llm: new ReplayProvider() });
  app = createApp({ log: () => {}, eventsPollMs: 50, attestation: async () => ({ model: "m", nonce: "n", checks: [], verified: true, recorded: true, at: "x" }) });
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

const get = async (p: string, init?: RequestInit) => fetch(base + p, init);

describe("server endpoints", () => {
  it("/alerts enriched with conversationId + txHash", async () => {
    const alerts = await (await get("/alerts")).json();
    expect(alerts[0]).toMatchObject({ id: 0, conversationId: "conv-investment-001", txHash: expect.any(String) });
  });
  it("/alerts/:id/evidence plaintext hashes to evidenceHash", async () => {
    const alerts = await (await get("/alerts")).json();
    const ev = await (await get("/alerts/0/evidence")).json();
    expect(createHash("sha256").update(ev.plaintext, "utf8").digest("hex")).toBe(alerts[0].evidenceHash);
    expect(ev.plaintext).not.toMatch(/7700 900461/);
    expect((await get("/alerts/999/evidence")).status).toBe(404);
  });
  it("/check returns verdicts from the local guard", async () => {
    expect((await (await get("/check?chain=near&address=goldbridge-desk.near")).json()).kind).toBe("block");
    expect((await (await get("/check?chain=tron&address=TWBUfSVjgRGQSENodtV6N1yattFFEHG31X")).json()).kind).toBe("warn");
    expect((await (await get("/check?chain=near&address=fresh.near")).json()).kind).toBe("allow");
    expect((await get("/check?chain=doge&address=x")).status).toBe(400);
  });
  it("/flows, /responders, /attestation", async () => {
    expect((await (await get("/flows/0")).json()).length).toBe(4);
    expect((await (await get("/responders")).json()).map((r: any) => r.name)).toEqual(["DemoWallet", "DemoSolver"]);
    expect((await (await get("/attestation")).json()).verified).toBe(true);
  });
  it("/snapshot is a complete DemoSnapshot", async () => {
    const s = (await (await get("/snapshot")).json()) as DemoSnapshot;
    expect(s.alerts.length).toBe(8);
    expect(s.conversations.length).toBe(3);
    expect(s.events.length).toBe(7);
    expect(Object.keys(s.flows)).toContain("0");
    expect(s.acks.every((a) => a.receivedAt)).toBe(true);
    expect(Object.keys(s.evidence!).length).toBe(8);
  });
  it("CORS allows the Vite dev origin", async () => {
    const r = await get("/alerts", { headers: { origin: "http://localhost:5173" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const r2 = await get("/alerts", { headers: { origin: "https://evil.example" } });
    expect(r2.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("/events streams history and new GuardEvents as default message events", async () => {
    const ctrl = new AbortController();
    const res = await get("/events", { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const fresh: GuardEvent = { id: "live-1", source: "agent-wallet", action: "refused", log: [], at: "now", verdict: { kind: "block", target: { chain: "near", address: "x.near" }, reasons: [], checkedAt: "now" } };
    setTimeout(() => appendEvent(fresh), 200);
    const deadline = Date.now() + 5000;
    while (!buf.includes('"live-1"') && Date.now() < deadline) buf += dec.decode((await reader.read()).value);
    ctrl.abort();
    const datas = buf.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    expect(datas.length).toBe(8);
    expect(datas.at(-1).id).toBe("live-1");
    expect(buf).not.toMatch(/^event:/m);
  });
});
