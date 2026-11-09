import { API, SERVER_PORT, type AttestationResult, type FlowEdge, type GuardEvent, type Responder } from "@baitnet/shared";
import { byTimeDesc, isGuardEvent, normalizeAlerts, normalizeEvent, parseSnapshot, type ViewSnapshot } from "./parse";

export type Mode = "live" | "snapshot";

export interface DataConfig {
  /** Backend base URL, or null when live mode should not be attempted. */
  apiBase: string | null;
  /** Forced mode from ?mode=; undefined = auto (live first, then snapshot). */
  forceMode?: Mode;
  /** Static snapshot URLs tried in order. */
  snapshotUrls: string[];
  liveTimeoutMs: number;
}

export interface LoadResult {
  mode: Mode;
  snapshot: ViewSnapshot;
  /** Where the data came from (URL). */
  source: string;
  /** Sections (arena/training/eval) borrowed from snapshot.sample.json because the real data lacked them. */
  sampleSections?: string[];
  /** Why live mode was not used (only in snapshot mode). */
  fallbackReason?: { kind: "unreachable" | "forced" | "static"; detail?: string };
}

type FetchFn = typeof fetch;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Decide data config from the page URL + build-time env. Pure, so it is unit-testable. */
export function resolveConfig(
  loc: { hostname: string; search: string; protocol?: string; port?: string },
  env: { VITE_API_BASE?: string; BASE_URL?: string } = {},
): DataConfig {
  const q = new URLSearchParams(loc.search);
  const m = q.get("mode");
  const forceMode: Mode | undefined = m === "live" || m === "snapshot" ? m : undefined;
  const explicit = q.get("api") || env.VITE_API_BASE || "";
  let apiBase: string | null = null;
  const local = LOCAL_HOSTS.has(loc.hostname) || loc.hostname.endsWith(".localhost");
  if (explicit) apiBase = explicit.replace(/\/+$/, "");
  // Local dev (Vite on 5173): backend on 8787. Deployed: frontend and API share one origin -> relative paths.
  // On a static-only host the relative probe gets index.html back and we degrade to the snapshot.
  else if (local && String(loc.port ?? "") !== String(SERVER_PORT))
    apiBase = `http://${LOCAL_HOSTS.has(loc.hostname) ? loc.hostname : "localhost"}:${SERVER_PORT}`;
  else apiBase = "";
  if (forceMode === "snapshot" || q.get("data") === "sample") apiBase = null;
  const base = (env.BASE_URL ?? "/").replace(/\/?$/, "/");
  return {
    apiBase,
    forceMode,
    // ?data=sample: demo / screenshots with the bundled sample only.
    snapshotUrls: q.get("data") === "sample" ? [`${base}snapshot.sample.json`] : [`${base}snapshot.json`, `${base}snapshot.sample.json`],
    liveTimeoutMs: 1500,
  };
}

async function fetchJson(fetchFn: FetchFn, url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, cache: "no-store", credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // Dev servers / SPA hosts answer missing files with index.html.
      throw new Error(`${url} -> not JSON`);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`${url} -> timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Load full state from the backend. Prefers GET /snapshot; falls back to composing individual endpoints. */
export async function loadLive(fetchFn: FetchFn, apiBase: string, timeoutMs: number): Promise<ViewSnapshot> {
  try {
    return parseSnapshot(await fetchJson(fetchFn, apiBase + API.snapshot, timeoutMs));
  } catch (snapErr) {
    // /alerts is the minimum: if it fails, the backend is unreachable.
    let alertsRaw: unknown;
    try {
      alertsRaw = await fetchJson(fetchFn, apiBase + API.alerts, timeoutMs);
    } catch {
      throw snapErr;
    }
    const alerts = normalizeAlerts(alertsRaw);
    const opt = (p: string) => fetchJson(fetchFn, apiBase + p, timeoutMs).catch(() => undefined);
    const [resp, att, ...flowLists] = await Promise.all([
      opt(API.responders),
      opt(API.attestation),
      ...alerts.map((a) => opt(API.flows(a.id))),
    ]);
    const flows: Record<number, FlowEdge[]> = {};
    alerts.forEach((a, i) => {
      const f = flowLists[i];
      if (Array.isArray(f) && f.length) flows[a.id] = f as FlowEdge[];
    });
    const respObj = resp as { responders?: Responder[]; acks?: unknown[] } | Responder[] | undefined;
    return parseSnapshot({
      generatedAt: new Date().toISOString(),
      network: "sandbox",
      registryContract: "",
      alerts,
      conversations: [],
      events: [],
      flows,
      responders: Array.isArray(respObj) ? respObj : respObj?.responders ?? [],
      acks: Array.isArray(respObj) ? [] : respObj?.acks ?? [],
      attestation: att as AttestationResult | undefined,
    });
  }
}

export async function loadSnapshot(fetchFn: FetchFn, urls: string[]): Promise<{ snapshot: ViewSnapshot; source: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return { snapshot: parseSnapshot(await fetchJson(fetchFn, url, 8000)), source: url };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new Error(`No snapshot available: ${errors.join("; ")}`);
}

const OPTIONAL_SECTIONS = ["arenaScripts", "arenaSessions", "eval", "evalRuns", "playbook", "corrections"] as const;
const isEmpty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * Older exports (and the live /snapshot before B1/B2 land) carry no Arena / Training / Eval data.
 * Fill only those missing sections from the bundled sample so the pages are never blank; the UI says so.
 */
export async function fillFromSample(r: LoadResult, fetchFn: FetchFn, sampleUrl: string | undefined): Promise<LoadResult> {
  if (!sampleUrl || r.source === sampleUrl) return r;
  const missing = OPTIONAL_SECTIONS.filter((k) => isEmpty(r.snapshot[k]));
  if (missing.length === 0) return r;
  try {
    const sample = parseSnapshot(await fetchJson(fetchFn, sampleUrl, 8000));
    const snapshot = { ...r.snapshot } as Record<string, unknown>;
    const used = missing.filter((k) => !isEmpty(sample[k]));
    for (const k of used) snapshot[k] = sample[k];
    return used.length ? { ...r, snapshot: snapshot as unknown as ViewSnapshot, sampleSections: used } : r;
  } catch {
    return r;
  }
}

/** Try live first (unless disabled), then degrade to the static snapshot. Missing arena/eval sections come from the sample. */
export async function loadInitial(cfg: DataConfig, fetchFn: FetchFn = fetch): Promise<LoadResult> {
  const r = await loadPrimary(cfg, fetchFn);
  return fillFromSample(r, fetchFn, cfg.snapshotUrls.find((u) => u.includes("sample")));
}

async function loadPrimary(cfg: DataConfig, fetchFn: FetchFn): Promise<LoadResult> {
  let fallbackReason: LoadResult["fallbackReason"];
  if (cfg.apiBase !== null && cfg.forceMode !== "snapshot") {
    try {
      const snapshot = await loadLive(fetchFn, cfg.apiBase, cfg.liveTimeoutMs);
      return { mode: "live", snapshot, source: cfg.apiBase || (typeof location !== "undefined" ? location.origin : "same-origin") };
    } catch (e) {
      fallbackReason = { kind: "unreachable", detail: (e as Error).message };
    }
  } else {
    fallbackReason = { kind: cfg.forceMode === "snapshot" ? "forced" : "static" };
  }
  const { snapshot, source } = await loadSnapshot(fetchFn, cfg.snapshotUrls);
  return { mode: "snapshot", snapshot, source, fallbackReason };
}

/** Merge a streamed GuardEvent into the snapshot (dedupe by id, newest first). */
export function mergeEvent(s: ViewSnapshot, raw: unknown): ViewSnapshot {
  if (!isGuardEvent(raw)) return s;
  const ev = normalizeEvent(raw as GuardEvent);
  const events = [ev, ...s.events.filter((e) => e.id !== ev.id)].sort(byTimeDesc);
  return { ...s, events };
}

/** Parse one SSE `data:` payload. Accepts a bare GuardEvent or { type, data|event }. */
export function parseSseData(data: string): GuardEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (isGuardEvent(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["data", "event", "payload"]) if (isGuardEvent(o[k])) return o[k] as GuardEvent;
  }
  return null;
}
