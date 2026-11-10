import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AttestationCheck, AttestationResult } from "@baitnet/shared";
import { allowLiveAttestation, fixturePath } from "@baitnet/agent";

/**
 * M10 — NEAR AI Cloud TEE attestation check, following
 * near-examples/nearai-cloud-verification-example:
 *   fresh nonce → GET /v1/attestation/report → verify nonce binding in report_data,
 *   Intel TDX quote (DCAP via Phala's public verifier), measurements vs tcb_info,
 *   event_log replay → RTMR3, compose hash, NVIDIA GPU evidence nonce (+ NRAS).
 *
 * Known limitation: all instances of a model share the signing key, so a
 * matching signature does not prove that a given reply came from the same
 * instance that produced this report.
 */

export const ATTESTATION_URL = "https://cloud-api.near.ai/v1/attestation/report";
export const DEFAULT_ATTEST_MODEL = process.env.NEARAI_ATTEST_MODEL || process.env.NEARAI_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const PHALA_VERIFY = "https://cloud-api.phala.network/api/v1/attestations/verify";
const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";

interface EventLogEntry {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}
interface TeeInfo {
  tcb_info?: { mrtd?: string; rtmr0?: string; rtmr1?: string; rtmr2?: string; rtmr3?: string; compose_hash?: string; app_compose?: string; event_log?: EventLogEntry[] } | string;
  compose_hash?: string;
}
interface TeeAttestation {
  signing_address: string;
  signing_algo?: string;
  intel_quote: string;
  event_log?: EventLogEntry[] | string;
  report_data?: string;
  request_nonce?: string;
  nvidia_payload?: string;
  info?: TeeInfo;
  model_name?: string;
}
export interface AttestationReport {
  gateway_attestation?: TeeAttestation;
  model_attestations?: TeeAttestation[];
  // older single-model shape
  signing_address?: string;
  intel_quote?: string;
  nvidia_payload?: string;
}

export interface RecordedFixture {
  recorded: { at: string; model: string; nonce: string; url: string; dcap?: Record<string, boolean>; nras?: Record<string, boolean>; note?: string };
  report: AttestationReport;
}

// ------------------------------------------------------------------ TDX quote parsing
/** TDX quote v4: 48-byte header, then 584-byte TD report body. */
export function parseTdxQuote(hex: string) {
  const q = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (q.length < 48 + 584) throw new Error(`quote too short (${q.length} bytes)`);
  const version = q.readUInt16LE(0);
  const teeType = q.readUInt32LE(4);
  const b = q.subarray(48, 48 + 584);
  const h = (o: number, n: number) => b.subarray(o, o + n).toString("hex");
  return { version, teeType, mrtd: h(136, 48), rtmr0: h(328, 48), rtmr1: h(376, 48), rtmr2: h(424, 48), rtmr3: h(472, 48), reportData: h(520, 64) };
}

/**
 * dstack runtime events carry an empty digest; it is
 * sha384(event_type as u32 LE || ":" || event || ":" || payload_bytes).
 */
export function eventDigest(e: EventLogEntry): Buffer {
  if (e.digest) return Buffer.from(e.digest, "hex");
  const t = Buffer.alloc(4);
  t.writeUInt32LE(e.event_type >>> 0);
  return createHash("sha384").update(Buffer.concat([t, Buffer.from(":"), Buffer.from(e.event), Buffer.from(":"), Buffer.from(e.event_payload, "hex")])).digest();
}

/** RTMR replay: rtmr = sha384(rtmr || digest) over the events for that IMR, starting from zeros. */
export function replayRtmr(events: EventLogEntry[], imr: number): string {
  let mr = Buffer.alloc(48);
  for (const e of events.filter((x) => x.imr === imr)) {
    let d = eventDigest(e);
    if (d.length < 48) d = Buffer.concat([d, Buffer.alloc(48 - d.length)]);
    mr = createHash("sha384").update(Buffer.concat([mr, d])).digest();
  }
  return mr.toString("hex");
}

/** report_data = signing_address (left-aligned, zero-padded to 32 bytes) || nonce (32 bytes). */
export function expectedReportData(signingAddress: string, nonce: string): string {
  const addr = Buffer.from(signingAddress.replace(/^0x/, ""), "hex");
  const first = Buffer.concat([addr, Buffer.alloc(Math.max(0, 32 - addr.length))]).subarray(0, 32);
  return first.toString("hex") + nonce.toLowerCase();
}

const parseMaybe = <T>(v: T | string | undefined): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : v);
const short = (s: string) => (s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

export interface VerifyOptions {
  online?: boolean;
  /** recorded external verifier results (offline mode) */
  recordedExternal?: RecordedFixture["recorded"];
  fetchImpl?: typeof fetch;
}

async function dcapVerify(quoteHex: string, f: typeof fetch): Promise<boolean> {
  const res = await f(PHALA_VERIFY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: quoteHex }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { quote?: { verified?: boolean } };
  return j.quote?.verified === true;
}

async function nrasVerify(payload: string, f: typeof fetch): Promise<boolean> {
  const res = await f(NRAS_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: payload, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  // response: [["JWT", "<overall jwt>"], {GPU-0: jwt, ...}]
  const overall = Array.isArray(body) && Array.isArray(body[0]) ? String(body[0][1]) : "";
  const claims = JSON.parse(Buffer.from(overall.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
  return claims["x-nvidia-overall-att-result"] === true;
}

function checkTee(label: string, a: TeeAttestation, nonce: string, checks: AttestationCheck[]) {
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name: `${label}: ${name}`, pass, detail });
  push("nonce echoed", a.request_nonce === undefined || a.request_nonce.toLowerCase() === nonce.toLowerCase(), `request_nonce ${short(a.request_nonce ?? "(absent)")} vs ours ${short(nonce)}`);
  let q: ReturnType<typeof parseTdxQuote> | undefined;
  try {
    q = parseTdxQuote(a.intel_quote);
    push("TDX quote parses", q.version === 4 && q.teeType === 0x81, `version ${q.version}, tee_type 0x${q.teeType.toString(16)} (0x81 = TDX)`);
  } catch (e) {
    push("TDX quote parses", false, (e as Error).message);
  }
  if (q) {
    const exp = expectedReportData(a.signing_address, nonce);
    push("report_data binds signing_address + nonce", q.reportData === exp, `quote report_data ${short(q.reportData)}; expected ${short(exp)} (address ${short(a.signing_address)})`);
    if (a.report_data) push("report_data field matches quote", a.report_data.toLowerCase() === q.reportData, "API report_data == quote report_data");
  }
  const tcb = parseMaybe<Exclude<TeeInfo["tcb_info"], string>>(a.info?.tcb_info);
  if (q && tcb?.rtmr3) {
    const same = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"].every((k) => (tcb as any)[k] === (q as any)[k]);
    push("measurements match tcb_info", same, "MRTD, RTMR0-3 from the quote equal info.tcb_info");
  }
  const events = parseMaybe<EventLogEntry[]>(a.event_log) ?? tcb?.event_log;
  if (events?.length && q) {
    const r3 = replayRtmr(events, 3);
    push("event_log replays to RTMR3", r3 === q.rtmr3, `replayed ${short(r3)} vs quote ${short(q.rtmr3)} (${events.filter((e) => e.imr === 3).length} events)`);
    const composeEv = events.find((e) => e.event === "compose-hash");
    const compose = tcb?.app_compose;
    if (composeEv && compose) {
      const h = createHash("sha256").update(compose).digest("hex");
      push("compose hash matches event_log", h === composeEv.event_payload, `sha256(app_compose) ${short(h)} vs event ${short(composeEv.event_payload)}`);
    }
  }
  if (a.nvidia_payload) {
    const p = JSON.parse(a.nvidia_payload) as { nonce?: string; evidence_list?: unknown[] };
    push("GPU evidence bound to nonce", p.nonce?.toLowerCase() === nonce.toLowerCase(), `nvidia_payload.nonce ${short(p.nonce ?? "")}, ${p.evidence_list?.length ?? 0} GPU(s)`);
  }
  return q;
}

/** Runs every check that can run (local ones always; DCAP/NRAS online or from recording). */
export async function verifyReport(report: AttestationReport, nonce: string, model: string, opts: VerifyOptions = {}): Promise<{ checks: AttestationCheck[]; signingAddress?: string; external: { dcap: Record<string, boolean>; nras: Record<string, boolean> } }> {
  const f = opts.fetchImpl ?? fetch;
  const checks: AttestationCheck[] = [];
  const external = { dcap: {} as Record<string, boolean>, nras: {} as Record<string, boolean> };
  const models = report.model_attestations ?? (report.intel_quote ? [report as TeeAttestation] : []);
  const m = models.find((x) => !x.model_name || x.model_name === model) ?? models[0];
  if (!m) {
    checks.push({ name: "model attestation present", pass: false, detail: `no model_attestations for ${model}` });
    return { checks, external };
  }
  checks.push({ name: "model attestation present", pass: true, detail: `${m.model_name ?? model}, signing ${m.signing_algo ?? "ecdsa"} ${m.signing_address}` });
  const tees: [string, TeeAttestation][] = [["model", m]];
  if (report.gateway_attestation) tees.push(["gateway", report.gateway_attestation]);
  for (const [label, a] of tees) {
    checkTee(label, a, nonce, checks);
    const name = `${label}: Intel DCAP quote signature`;
    if (opts.online) {
      try {
        external.dcap[label] = await dcapVerify(a.intel_quote, f);
        checks.push({ name, pass: external.dcap[label]!, detail: `verified by ${PHALA_VERIFY}` });
      } catch (e) {
        checks.push({ name, pass: false, detail: `verifier unreachable: ${(e as Error).message}` });
      }
    } else {
      const rec = opts.recordedExternal?.dcap?.[label];
      checks.push({ name, pass: rec === true, detail: rec === undefined ? "not run offline" : `recorded verifier result at ${opts.recordedExternal!.at}` });
    }
  }
  if (m.nvidia_payload) {
    const name = "model: NVIDIA NRAS GPU attestation";
    if (opts.online) {
      try {
        external.nras.model = await nrasVerify(m.nvidia_payload, f);
        checks.push({ name, pass: external.nras.model, detail: `x-nvidia-overall-att-result from ${NRAS_URL}` });
      } catch (e) {
        checks.push({ name, pass: false, detail: `NRAS unreachable: ${(e as Error).message}` });
      }
    } else {
      const rec = opts.recordedExternal?.nras?.model;
      checks.push({ name, pass: rec === true, detail: rec === undefined ? "not run offline" : `recorded NRAS result at ${opts.recordedExternal!.at}` });
    }
  }
  return { checks, signingAddress: m.signing_address, external };
}

export const newNonce = () => randomBytes(32).toString("hex");

export async function fetchReport(model: string, nonce: string, f: typeof fetch = fetch): Promise<AttestationReport> {
  const url = new URL(ATTESTATION_URL);
  url.searchParams.set("model", model);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("signing_algo", "ecdsa");
  const res = await f(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as AttestationReport;
}

export function loadRecorded(path = fixturePath("attestation", "sample-report.json")): RecordedFixture | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RecordedFixture) : null;
}

/**
 * Offline (default; D8): serve the recorded fixture only — no network at all.
 * Live (BAITNET_MODE=live or BAITNET_LIVE_ATTESTATION=1): fresh nonce per call,
 * full online verification; on any failure, log and fall back to the recording.
 */
export async function getAttestation(
  opts: { model?: string; live?: boolean; fetchImpl?: typeof fetch; log?: (s: string) => void } = {},
): Promise<AttestationResult> {
  const model = opts.model ?? DEFAULT_ATTEST_MODEL;
  const log = opts.log ?? ((s: string) => console.warn(s));
  const live = opts.live ?? allowLiveAttestation();
  if (live) {
    const nonce = newNonce();
    try {
      const report = await fetchReport(model, nonce, opts.fetchImpl);
      const { checks, signingAddress } = await verifyReport(report, nonce, model, { online: true, fetchImpl: opts.fetchImpl });
      return { model, nonce, signingAddress, checks, verified: checks.every((c) => c.pass), recorded: false, at: new Date().toISOString() };
    } catch (e) {
      log(`[attestation] live fetch failed (${(e as Error).message}); falling back to recorded fixtures/attestation/sample-report.json`);
    }
  }
  const rec = loadRecorded();
  if (!rec) {
    return { model, nonce: "", checks: [{ name: "attestation available", pass: false, detail: "no live attestation and no fixtures/attestation/sample-report.json" }], verified: false, recorded: true, at: new Date().toISOString() };
  }
  const { checks, signingAddress } = await verifyReport(rec.report, rec.recorded.nonce, rec.recorded.model, { online: false, recordedExternal: rec.recorded });
  return { model: rec.recorded.model, nonce: rec.recorded.nonce, signingAddress, checks, verified: checks.every((c) => c.pass), recorded: true, at: rec.recorded.at };
}

/** How long GET /attestation reuses a live result (BAITNET_ATTESTATION_CACHE_MS overrides). */
export const DEFAULT_ATTESTATION_CACHE_MS = 10 * 60_000;
/** A recorded result (offline mode, or live fetch failed) is recomputed / live retried after this. */
export const ATTESTATION_RETRY_MS = 60_000;

/**
 * Stale-while-revalidate wrapper for the dashboard's GET /attestation. A live check is a NEAR AI
 * report plus Phala DCAP (gateway + model) and NVIDIA NRAS — four sequential HTTPS calls, 3–12 s —
 * and every open dashboard polls it every 10 s. The first call waits; afterwards the cached
 * result is returned at once and refreshed in the background once it is older than `ttlMs`
 * (`retryMs` for a recorded result). A live result is not replaced by the recorded fallback when
 * a refresh fails. The zero-retention analysis (D27) calls fetchReport/verifyReport itself with
 * its own nonce and is not affected.
 */
export class AttestationCache {
  private value?: { at: number; result: AttestationResult; ttl: number };
  private inflight?: Promise<AttestationResult>;
  private readonly now: () => number;
  refreshes = 0;

  constructor(
    private load: () => Promise<AttestationResult>,
    private opts: { ttlMs?: number; retryMs?: number; now?: () => number; log?: (s: string) => void } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  get(): Promise<AttestationResult> {
    const v = this.value;
    if (!v) return this.refresh();
    if (this.now() - v.at >= v.ttl) void this.refresh().catch(() => {});
    return Promise.resolve(v.result);
  }

  /** The cached result, if any (no network). */
  peek(): AttestationResult | undefined {
    return this.value?.result;
  }

  refresh(): Promise<AttestationResult> {
    if (this.inflight) return this.inflight;
    this.refreshes++;
    const p = this.load()
      .then((result) => {
        const prev = this.value;
        const ttlMs = this.opts.ttlMs ?? DEFAULT_ATTESTATION_CACHE_MS;
        const retryMs = Math.min(this.opts.retryMs ?? ATTESTATION_RETRY_MS, ttlMs);
        if (result.recorded && prev && !prev.result.recorded) {
          // live refresh failed (getAttestation fell back to the recording): keep the last live result
          this.value = { ...prev, at: this.now(), ttl: retryMs };
          return prev.result;
        }
        this.value = { at: this.now(), result, ttl: result.recorded ? retryMs : ttlMs };
        return result;
      })
      .catch((e: Error) => {
        this.opts.log?.(`[attestation] refresh failed: ${e.message}`);
        if (this.value) {
          this.value = { ...this.value, at: this.now(), ttl: Math.min(this.opts.retryMs ?? ATTESTATION_RETRY_MS, this.value.ttl) };
          return this.value.result;
        }
        throw e;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    this.inflight = p;
    return p;
  }
}
