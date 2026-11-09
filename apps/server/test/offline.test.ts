import { afterEach, describe, expect, it, vi } from "vitest";
import { allowLiveAttestation, fullDemo, makeCtx, ReplayProvider } from "@baitnet/agent";
import { getAttestation } from "../src/attestation.js";
import { DataSource } from "../src/data.js";

const ENV_KEYS = ["BAITNET_MODE", "BAITNET_LIVE_ATTESTATION", "BAITNET_OFFLINE", "BAITNET_REGISTRY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

describe("D8: offline mode makes no network requests", () => {
  it("attestation policy: offline by default, live only when asked", () => {
    expect(allowLiveAttestation({})).toBe(false);
    expect(allowLiveAttestation({ BAITNET_MODE: "offline" })).toBe(false);
    expect(allowLiveAttestation({ BAITNET_MODE: "offline", BAITNET_LIVE_ATTESTATION: "1" })).toBe(true);
    expect(allowLiveAttestation({ BAITNET_MODE: "live" })).toBe(true);
    expect(allowLiveAttestation({ BAITNET_MODE: "live", BAITNET_OFFLINE: "1" })).toBe(false);
  });

  for (const mode of ["offline", undefined]) {
    it(`export path (snapshot + attestation) never calls fetch (BAITNET_MODE=${mode ?? "unset"})`, async () => {
      if (mode) process.env.BAITNET_MODE = mode;
      else delete process.env.BAITNET_MODE;
      process.env.BAITNET_REGISTRY = "memory";
      const spy = vi.fn(async () => {
        throw new Error("network used in offline mode");
      });
      vi.stubGlobal("fetch", spy);
      await fullDemo(makeCtx(() => {}), { llm: new ReplayProvider() });
      const att = await getAttestation();
      const snap = await new DataSource().snapshot(att);
      expect(spy).not.toHaveBeenCalled();
      expect(snap.attestation).toMatchObject({ recorded: true, verified: true });
    });
  }

  it("live mode does fetch, and falls back to the recording when it fails", async () => {
    process.env.BAITNET_MODE = "live";
    const spy = vi.fn(async () => {
      throw new Error("unreachable");
    });
    vi.stubGlobal("fetch", spy);
    const logs: string[] = [];
    const att = await getAttestation({ log: (s) => logs.push(s) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(att.recorded).toBe(true);
    expect(logs.join("\n")).toMatch(/falling back to recorded/);
  });
});
