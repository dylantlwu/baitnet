import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fullDemo, makeCtx } from "../src/demo.js";
import { selectProvider } from "../src/llm/provider.js";
import { networkMode } from "../src/mode.js";

const KEYS = ["BAITNET_MODE", "BAITNET_REGISTRY", "NEARAI_API_KEY", "ANTHROPIC_API_KEY", "INTENTS_EXPLORER_JWT", "LIVE_INTENTS", "BAITNET_LLM"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

describe("D8 offline policy (M1 LLM, M6 1Click, M7 Intents Explorer)", () => {
  it("offline/testnet mode always replays, even with keys present", () => {
    const keys = { NEARAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" };
    expect(selectProvider({ ...keys, BAITNET_MODE: "offline" }).name).toBe("replay");
    expect(selectProvider({ ...keys, BAITNET_MODE: "testnet" }).name).toBe("replay");
    expect(selectProvider({ ...keys, BAITNET_MODE: "offline", BAITNET_LLM: "" }).name).toBe("replay");
    expect(selectProvider({ ...keys, BAITNET_MODE: "live" }).name).toBe("nearai");
    expect(networkMode({})).toBe("auto");
  });

  it("full ①–⑥ demo in offline mode makes zero fetch calls even with every key/JWT set", async () => {
    Object.assign(process.env, {
      BAITNET_MODE: "offline",
      BAITNET_REGISTRY: "memory",
      NEARAI_API_KEY: "nk",
      ANTHROPIC_API_KEY: "ak",
      INTENTS_EXPLORER_JWT: "jwt",
      LIVE_INTENTS: "1",
    });
    delete process.env.BAITNET_LLM;
    const spy = vi.fn(async () => {
      throw new Error("network used in offline mode");
    });
    vi.stubGlobal("fetch", spy);
    const logs: string[] = [];
    const { events } = await fullDemo(makeCtx((l) => logs.push(l))); // provider chosen by env, not forced
    expect(spy).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/provider=replay/);
    expect(logs.join("\n")).toMatch(/JWT ignored offline/);
    expect(events.some((e) => e.action === "quote-refused")).toBe(true);
  });

  it("live mode does use the network (control)", async () => {
    Object.assign(process.env, { BAITNET_MODE: "live", BAITNET_REGISTRY: "memory", INTENTS_EXPLORER_JWT: "jwt" });
    delete process.env.NEARAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const spy = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", spy);
    const { stepTrace } = await import("../src/demo.js");
    const prevDir = process.env.BAITNET_DATA_DIR;
    process.env.BAITNET_DATA_DIR = mkdtempSync(join(tmpdir(), "baitnet-live-")); // one root only → one rate-limited call
    const ctx = makeCtx(() => {});
    process.env.BAITNET_DATA_DIR = prevDir;
    await ctx.env.registry.report({ chain: "near", address: "goldbridge-desk.near", evidenceHash: "d".repeat(64), level: "L1", category: "investment" });
    await stepTrace(ctx);
    expect(spy).toHaveBeenCalled(); // explorer attempted, then fell back to sample data
  });
});
