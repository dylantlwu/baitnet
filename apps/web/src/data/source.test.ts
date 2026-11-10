import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseSnapshot, SnapshotParseError } from "./parse";
import { LIVE_TIMEOUT_MS, loadInitial, loadLive, mergeEvent, parseSseData, resolveConfig, type DataConfig } from "./source";
import { hasArenaApi } from "../backend/http";
import { sha256Hex } from "../lib/sha256";
import { tokenize } from "../lib/tokens";
import { layoutFlow } from "../lib/graph";

const samplePath = fileURLToPath(new URL("../../public/snapshot.sample.json", import.meta.url));
const sampleText = readFileSync(samplePath, "utf8");
const sample = JSON.parse(sampleText);

type Route = Record<string, { status?: number; body: string } | "network-error">;
function fakeFetch(routes: Route) {
  return vi.fn(async (url: string | URL | Request) => {
    const r = routes[String(url)];
    if (!r || r === "network-error") throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return new Response(r.body, { status });
  }) as unknown as typeof fetch;
}

const cfg = (over: Partial<DataConfig> = {}): DataConfig => ({
  apiBase: "http://localhost:8787",
  snapshotUrls: ["/snapshot.json", "/snapshot.sample.json"],
  liveTimeoutMs: 200,
  ...over,
});

describe("resolveConfig", () => {
  it("tries live on localhost", () => {
    const c = resolveConfig({ hostname: "localhost", search: "", port: "5173" });
    expect(c.apiBase).toBe("http://localhost:8787");
    expect(c.snapshotUrls).toEqual(["/snapshot.json", "/snapshot.sample.json"]);
  });
  it("uses same-origin relative paths when deployed (and 8787 only for local dev)", () => {
    expect(resolveConfig({ hostname: "baitnet.example.org", search: "" }).apiBase).toBe("");
    expect(resolveConfig({ hostname: "localhost", search: "", port: "8787" }).apiBase).toBe("");
    expect(resolveConfig({ hostname: "localhost", search: "", port: "5173" }).apiBase).toBe("http://localhost:8787");
    expect(resolveConfig({ hostname: "baitnet.vercel.app", search: "" }, { VITE_API_BASE: "https://api.example/" }).apiBase).toBe(
      "https://api.example",
    );
  });
  it("production build served by apps/server on a localhost port uses the same origin (not :8787)", () => {
    expect(resolveConfig({ hostname: "localhost", search: "", port: "8099" }).apiBase).toBe("");
    expect(resolveConfig({ hostname: "127.0.0.1", search: "", port: "8098" }, { DEV: false }).apiBase).toBe("");
    // Vite dev server on another port still talks to the dev backend
    expect(resolveConfig({ hostname: "localhost", search: "", port: "5174" }, { DEV: true }).apiBase).toBe("http://localhost:8787");
    expect(resolveConfig({ hostname: "localhost", search: "?api=http://localhost:8099", port: "5173" }).apiBase).toBe("http://localhost:8099");
  });
  it("live probe waits long enough for a phone behind a VPN", () => {
    expect(LIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
    expect(resolveConfig({ hostname: "baitnet.example.org", search: "" }).liveTimeoutMs).toBe(LIVE_TIMEOUT_MS);
  });
  it("honours ?mode=snapshot and ?api=", () => {
    expect(resolveConfig({ hostname: "localhost", search: "?mode=snapshot" }).apiBase).toBeNull();
    expect(resolveConfig({ hostname: "x.dev", search: "?api=http://10.0.0.2:8787" }).apiBase).toBe("http://10.0.0.2:8787");
    expect(resolveConfig({ hostname: "x.dev", search: "?mode=snapshot" }).apiBase).toBeNull();
  });
});

describe("parseSnapshot", () => {
  it("parses the bundled sample and covers every page", () => {
    const s = parseSnapshot(sampleText);
    expect(s.alerts.length).toBeGreaterThan(0);
    expect(s.conversations.length).toBeGreaterThan(0);
    expect(new Set(s.events.map((e) => e.source))).toEqual(new Set(["agent-wallet", "intents-solver"]));
    expect(new Set(s.events.map((e) => e.verdict.kind))).toEqual(new Set(["allow", "warn", "block"]));
    expect(Object.keys(s.flows).length).toBeGreaterThan(0);
    expect(s.responders.length).toBeGreaterThan(0);
    expect(s.acks.length).toBeGreaterThan(0);
    expect(s.attestation?.checks.length).toBeGreaterThan(0);
    // events sorted newest first
    expect(s.events[0].at >= s.events[s.events.length - 1].at).toBe(true);
  });

  it("sample evidence hashes match sha256(plaintext)", async () => {
    const s = parseSnapshot(sample);
    for (const a of s.alerts) expect(await sha256Hex(s.evidence![a.id])).toBe(a.evidenceHash);
  });

  it("normalizes string flow keys, 0x-prefixed hashes and missing arrays", () => {
    const s = parseSnapshot({
      alerts: [{ id: "2", chain: "near", address: "bad.near", evidenceHash: "0xABCD" }],
      flows: { "2": [{ from: "a", to: "b", protocol: "transfer", chain: "near", ts: "t" }], nope: [] },
    });
    expect(s.alerts[0]).toMatchObject({ id: 2, evidenceHash: "abcd", status: "Active", level: "L1" });
    expect(s.flows[2]).toHaveLength(1);
    expect(s.events).toEqual([]);
    expect(s.network).toBe("sandbox");
  });

  it("rejects non-snapshots (e.g. an SPA index.html fallback)", () => {
    expect(() => parseSnapshot("<!doctype html><html>")).toThrow(SnapshotParseError);
    expect(() => parseSnapshot({ foo: 1 })).toThrow(/alerts/);
  });
});

describe("loadInitial (mode degradation)", () => {
  it("uses live mode when GET /snapshot answers", async () => {
    const f = fakeFetch({ "http://localhost:8787/snapshot": { body: sampleText } });
    const r = await loadInitial(cfg(), f);
    expect(r.mode).toBe("live");
    expect(r.source).toBe("http://localhost:8787");
  });

  it("composes live data from /alerts when /snapshot is missing", async () => {
    const f = fakeFetch({
      "http://localhost:8787/snapshot": { status: 404, body: "not found" },
      "http://localhost:8787/alerts": { body: JSON.stringify(sample.alerts) },
      "http://localhost:8787/responders": { body: JSON.stringify({ responders: sample.responders, acks: sample.acks }) },
      "http://localhost:8787/flows/1": { body: JSON.stringify(sample.flows["1"]) },
    });
    const r = await loadInitial(cfg(), f);
    expect(r.mode).toBe("live");
    expect(r.snapshot.alerts).toHaveLength(sample.alerts.length);
    expect(r.snapshot.flows[1]).toHaveLength(sample.flows["1"].length);
    expect(r.snapshot.acks).toHaveLength(sample.acks.length);
  });

  it("401 on /snapshot = backend online with login: live mode, public data, authRequired", async () => {
    const f = fakeFetch({
      "/snapshot": { status: 401, body: JSON.stringify({ error: "login required" }) },
      "/alerts": { body: JSON.stringify(sample.alerts) },
      "/responders": { body: JSON.stringify({ responders: sample.responders, acks: sample.acks }) },
      "/snapshot.sample.json": { body: sampleText },
    });
    const r = await loadInitial(cfg({ apiBase: "" }), f);
    expect(r.mode).toBe("live");
    expect(r.authRequired).toBe(true);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.snapshot.alerts).toHaveLength(sample.alerts.length);
    // the static snapshot.json is never consulted
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).not.toContain("/snapshot.json");
  });

  it("401/403 everywhere still means live (empty until login), never snapshot", async () => {
    const f = fakeFetch({
      "/snapshot": { status: 403, body: "{}" },
      "/alerts": { status: 401, body: "{}" },
      "/snapshot.json": { body: sampleText },
    });
    const r = await loadInitial(cfg({ apiBase: "" }), f);
    expect(r.mode).toBe("live");
    expect(r.authRequired).toBe(true);
    expect(r.snapshot.alerts).toEqual([]);
  });

  it("polling while logged out skips /snapshot (no 401 every 10 s)", async () => {
    const f = fakeFetch({ "/alerts": { body: JSON.stringify(sample.alerts) } });
    const s = await loadLive(f, "", 200, { skipSnapshot: true });
    expect(s.alerts).toHaveLength(sample.alerts.length);
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).not.toContain("/snapshot");
  });

  it("logged in: /snapshot answers -> live without authRequired", async () => {
    const r = await loadInitial(cfg({ apiBase: "" }), fakeFetch({ "/snapshot": { body: sampleText } }));
    expect(r.mode).toBe("live");
    expect(r.authRequired).toBeUndefined();
  });

  it("Arena API behind a login counts as present (http backend, not the in-browser mock)", async () => {
    expect(await hasArenaApi("", fakeFetch({ "/arena/scripts": { status: 401, body: "{}" } }))).toBe(true);
    expect(await hasArenaApi("", fakeFetch({ "/arena/scripts": { status: 404, body: "nope" } }))).toBe(false);
  });

  it("falls back to snapshot.json when the backend is down", async () => {
    const f = fakeFetch({ "/snapshot.json": { body: sampleText } });
    const r = await loadInitial(cfg(), f);
    expect(r.mode).toBe("snapshot");
    expect(r.source).toBe("/snapshot.json");
    expect(r.fallbackReason?.kind).toBe("unreachable");
  });

  it("falls back to the sample when snapshot.json is absent or is HTML", async () => {
    const f = fakeFetch({
      "/snapshot.json": { body: "<!doctype html><title>spa</title>" },
      "/snapshot.sample.json": { body: sampleText },
    });
    const r = await loadInitial(cfg(), f);
    expect(r.mode).toBe("snapshot");
    expect(r.source).toBe("/snapshot.sample.json");
  });

  it("treats a hanging backend as down (timeout)", async () => {
    const hang = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("http://localhost:8787"))
        return new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      return Promise.resolve(new Response(sampleText));
    }) as unknown as typeof fetch;
    const r = await loadInitial(cfg({ liveTimeoutMs: 30 }), hang);
    expect(r.mode).toBe("snapshot");
    expect(r.fallbackReason?.detail).toMatch(/timeout/);
    expect(r.fallbackReason?.kind).toBe("timeout");
  });

  it("same-origin deploy: relative probe, credentials included", async () => {
    const seen: RequestInit[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      if (url === "/snapshot") return new Response(sampleText);
      throw new TypeError("no");
    }) as unknown as typeof fetch;
    const r = await loadInitial(cfg({ apiBase: "" }), f);
    expect(r.mode).toBe("live");
    expect(seen[0].credentials).toBe("include");
  });

  it("static host: relative probe returns index.html -> snapshot mode", async () => {
    const f = fakeFetch({ "/snapshot": { body: "<!doctype html>" }, "/alerts": { body: "<!doctype html>" }, "/snapshot.json": { body: sampleText } });
    const r = await loadInitial(cfg({ apiBase: "" }), f);
    expect(r.mode).toBe("snapshot");
  });

  it("does not touch the backend when apiBase is null", async () => {
    const f = fakeFetch({ "/snapshot.json": { body: sampleText } });
    const r = await loadInitial(cfg({ apiBase: null }), f);
    expect(r.mode).toBe("snapshot");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("throws when nothing is available", async () => {
    await expect(loadInitial(cfg(), fakeFetch({}))).rejects.toThrow(/No snapshot available/);
  });
});

describe("SSE merge", () => {
  it("parses bare and wrapped events and dedupes by id", () => {
    const s = parseSnapshot(sample);
    const ev = { ...sample.events[0], id: "evt-new", at: "2030-01-01T00:00:00.000Z" };
    expect(parseSseData(JSON.stringify(ev))?.id).toBe("evt-new");
    expect(parseSseData(JSON.stringify({ type: "guard", data: ev }))?.id).toBe("evt-new");
    expect(parseSseData("ping")).toBeNull();
    const once = mergeEvent(s, ev);
    const twice = mergeEvent(once, ev);
    expect(twice.events).toHaveLength(s.events.length + 1);
    expect(twice.events[0].id).toBe("evt-new");
  });
});

describe("tokenize / layout", () => {
  it("highlights addresses and redacts personal data", () => {
    const toks = tokenize(
      "Send to 0x7a3f9ca274c627d693137f3030ea82b262d3dfc3 or refund-helpdesk.testnet, ping @apex_mentor_lisa / +44 7700 900481 / a.b.near@proton.me at https://evil.io/x.",
    );
    const kinds = toks.filter((t) => t.kind !== "text").map((t) => (t.kind === "pii" ? `pii:${t.label}` : t.kind === "address" ? `addr:${t.chain}` : t.kind));
    expect(kinds).toEqual(["addr:evm", "addr:near", "pii:handle", "pii:phone", "pii:email", "url"]);
  });
  it("lays out the sample flow as a DAG", () => {
    const L = layoutFlow(sample.flows["1"]);
    expect(L.nodes.length).toBe(7);
    for (const e of L.edges) expect(e.y2).toBeGreaterThan(e.y1);
  });
});

describe("fillFromSample", () => {
  it("borrows only missing arena/training/eval sections from the sample", async () => {
    const real = { ...sample, arenaScripts: undefined, arenaSessions: [], eval: undefined, evalRuns: undefined, playbook: undefined, corrections: undefined };
    const f = fakeFetch({ "/snapshot.json": { body: JSON.stringify(real) }, "/snapshot.sample.json": { body: sampleText } });
    const r = await loadInitial(cfg({ apiBase: null }), f);
    expect(r.source).toBe("/snapshot.json");
    expect(r.sampleSections).toEqual(["arenaScripts", "arenaSessions", "eval", "evalRuns", "playbook", "corrections"]);
    expect(r.snapshot.arenaSessions?.length).toBeGreaterThan(0);
    expect(r.snapshot.alerts).toHaveLength(sample.alerts.length);
  });
});
