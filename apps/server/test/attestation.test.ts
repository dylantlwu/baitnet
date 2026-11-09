import { describe, expect, it } from "vitest";
import { expectedReportData, getAttestation, loadRecorded, parseTdxQuote, replayRtmr, verifyReport } from "../src/attestation.js";

const rec = loadRecorded()!;

describe("M10 attestation (recorded real report)", () => {
  it("fixture is a real recording", () => {
    expect(rec.recorded.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.report.model_attestations?.length).toBeGreaterThan(0);
  });
  it("all local checks pass on the recorded report", async () => {
    const { checks } = await verifyReport(rec.report, rec.recorded.nonce, rec.recorded.model, { online: false, recordedExternal: rec.recorded });
    const failed = checks.filter((c) => !c.pass);
    expect(failed).toEqual([]);
    const names = checks.map((c) => c.name).join("|");
    for (const n of ["nonce echoed", "report_data binds", "event_log replays to RTMR3", "compose hash", "GPU evidence bound", "Intel DCAP"]) expect(names).toContain(n);
  });
  it("a different nonce fails the binding checks (replay protection)", async () => {
    const { checks } = await verifyReport(rec.report, "00".repeat(32), rec.recorded.model, { online: false });
    expect(checks.find((c) => c.name === "model: report_data binds signing_address + nonce")!.pass).toBe(false);
    expect(checks.find((c) => c.name === "model: nonce echoed")!.pass).toBe(false);
  });
  it("tampered event log no longer replays to RTMR3", () => {
    const m = rec.report.model_attestations![0]!;
    const q = parseTdxQuote(m.intel_quote);
    const ev = (typeof m.event_log === "string" ? JSON.parse(m.event_log) : m.event_log) as any[];
    expect(replayRtmr(ev, 3)).toBe(q.rtmr3);
    const bad = ev.map((e) => (e.event === "compose-hash" ? { ...e, event_payload: "00".repeat(32) } : e));
    expect(replayRtmr(bad, 3)).not.toBe(q.rtmr3);
  });
  it("report_data layout = address padded to 32 bytes || nonce", () => {
    expect(expectedReportData("0x" + "ab".repeat(20), "cd".repeat(32))).toBe("ab".repeat(20) + "00".repeat(12) + "cd".repeat(32));
  });
  it("offline mode serves the recording with recorded: true", async () => {
    const r = await getAttestation({ live: false });
    expect(r).toMatchObject({ recorded: true, verified: true, nonce: rec.recorded.nonce });
  });
  it("live mode uses a fresh nonce each time and falls back (logged) when unreachable", async () => {
    const nonces: string[] = [];
    const logs: string[] = [];
    const f = (async (u: URL) => {
      nonces.push(new URL(String(u)).searchParams.get("nonce")!);
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const a = await getAttestation({ live: true, fetchImpl: f, log: (s) => logs.push(s) });
    await getAttestation({ live: true, fetchImpl: f, log: (s) => logs.push(s) });
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(a).toMatchObject({ recorded: true, verified: true });
    expect(logs[0]).toMatch(/live fetch failed \(ENOTFOUND\); falling back to recorded/);
  });
});
