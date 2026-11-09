import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider, NearAIProvider, ReplayProvider, selectProvider, type LLMProvider } from "../src/llm/provider.js";
import { runBait } from "../src/bait/bait.js";

afterEach(() => vi.unstubAllGlobals());

describe("LLMProvider selection", () => {
  it("nearai → claude → replay by env", () => {
    expect(selectProvider({ NEARAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" }).name).toBe("nearai");
    expect(selectProvider({ ANTHROPIC_API_KEY: "a" }).name).toBe("claude");
    expect(selectProvider({ ANTHROPIC_API_KEY: "a" }).model).toBe("claude-sonnet-5-5");
    expect(selectProvider({}).name).toBe("replay");
    expect(selectProvider({ NEARAI_API_KEY: "k", BAITNET_LLM: "replay" }).name).toBe("replay");
  });
  it("Claude provider speaks the Messages API", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "Which address?" }] })));
    vi.stubGlobal("fetch", f);
    const out = await new ClaudeProvider("key").complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("Which address?");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "claude-sonnet-5-5", system: "s" });
  });
  it("NEAR AI provider is OpenAI-compatible", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    vi.stubGlobal("fetch", f);
    expect(await new NearAIProvider("key").complete({ system: "s", messages: [{ role: "user", content: "hi" }] })).toBe("ok");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://cloud-api.near.ai/v1/chat/completions");
  });
});

describe("bait (M1)", () => {
  it("replay is deterministic and fast", async () => {
    const t0 = Date.now();
    const a = await runBait(new ReplayProvider(), "investment");
    const b = await runBait(new ReplayProvider(), "investment");
    expect(a).toEqual(b);
    expect(a.provider).toBe("replay");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("live mode alternates roles and stops after addresses appear", async () => {
    let i = 0;
    const fake: LLMProvider = {
      name: "claude",
      model: "fake",
      complete: async (req) => (req.system.includes("SIMULATED scammer") ? (i++ < 2 ? "Great returns!" : "Send USDT to goldbridge-desk.near or 0x220954f527d61a281b50846419d12a1154c7da46") : "Which address and chain?"),
    };
    const c = await runBait(fake, "investment", { maxTurns: 20 });
    expect(c.provider).toBe("claude");
    expect(c.turns[0]!.role).toBe("scammer");
    expect(c.turns[1]!.role).toBe("bait");
    expect(c.turns.length).toBeLessThan(20);
  });
  it("falls back to replay when the live provider fails", async () => {
    const broken: LLMProvider = { name: "nearai", model: "x", complete: async () => { throw new Error("402"); } };
    const c = await runBait(broken, "fake-support");
    expect(c.provider).toBe("replay");
    expect(c.id).toBe("conv-fake-support-001");
  });
});
