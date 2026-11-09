import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider, NearAIClaudeProvider, NearAIProvider, ReplayProvider, isNonTeeModelId, selectClaudeProvider, selectProvider, type LLMProvider } from "../src/llm/provider.js";
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

describe("Claude via NEAR AI (one NEAR AI key runs everything)", () => {
  it("only a NEAR AI key: default stays the TEE model; BAITNET_LLM=claude → Claude via NEAR AI", () => {
    const d = selectProvider({ NEARAI_API_KEY: "k" });
    expect(d).toBeInstanceOf(NearAIProvider);
    expect(d.via).toBe("nearai");
    expect(d.tee).toBe(true);
    const c = selectProvider({ NEARAI_API_KEY: "k", BAITNET_LLM: "claude" });
    expect(c).toBeInstanceOf(NearAIClaudeProvider);
    expect(c.name).toBe("claude");
    expect(c.via).toBe("nearai");
    expect(c.tee).toBe(false);
    expect(c.model).toBe("anthropic/claude-sonnet-5-5");
    expect(selectProvider({ NEARAI_API_KEY: "k", BAITNET_LLM: "claude", NEARAI_CLAUDE_MODEL: "anthropic/claude-opus-5-5" }).model).toBe("anthropic/claude-opus-5-5");
  });
  it("empty model env vars (as in .env.example) fall back to the defaults instead of model \"\"", () => {
    expect(selectProvider({ NEARAI_API_KEY: "k", NEARAI_MODEL: "" }).model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
    expect(selectProvider({ NEARAI_API_KEY: "k", BAITNET_LLM: "claude", NEARAI_CLAUDE_MODEL: "" }).model).toBe("anthropic/claude-sonnet-5-5");
    expect(selectProvider({ ANTHROPIC_API_KEY: "a", CLAUDE_MODEL: "" }).model).toBe("claude-sonnet-5-5");
  });
  it("ANTHROPIC_API_KEY wins for the claude engine (direct channel)", () => {
    const c = selectProvider({ NEARAI_API_KEY: "k", ANTHROPIC_API_KEY: "a", BAITNET_LLM: "claude" });
    expect(c).toBeInstanceOf(ClaudeProvider);
    expect(c.via).toBe("anthropic");
    expect(c.tee).toBe(false);
    expect(selectProvider({ ANTHROPIC_API_KEY: "a" }).via).toBe("anthropic");
    expect(selectClaudeProvider({})).toBeUndefined();
    expect(selectClaudeProvider({ NEARAI_API_KEY: "k" })?.via).toBe("nearai");
    expect(selectProvider({ BAITNET_LLM: "claude" }).name).toBe("replay");
    expect(selectProvider({ NEARAI_API_KEY: "k", BAITNET_LLM: "nearai", ANTHROPIC_API_KEY: "a" }).name).toBe("nearai");
  });
  it("offline mode: no Claude-via-NEAR-AI, no fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const mode of ["offline", "testnet"]) {
      const p = selectProvider({ BAITNET_MODE: mode, NEARAI_API_KEY: "k", BAITNET_LLM: "claude" });
      expect(p.name).toBe("replay");
      await runBait(p, "investment");
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("speaks OpenAI chat/completions to NEAR AI with a Bearer key and the Claude model id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: " Which chain? " } }] })));
    vi.stubGlobal("fetch", f);
    const p = selectProvider({ NEARAI_API_KEY: "test-key", BAITNET_LLM: "claude" });
    expect(await p.complete({ system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 123 })).toBe("Which chain?");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(url).not.toContain("anthropic.com");
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer test-key");
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-api-key"]).toBeUndefined();
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      max_tokens: 2000, // caller asked for 123 → floor 2000 (adaptive thinking)
      temperature: 0.7,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
  });
  const chatResp = (content: string, finish_reason = "stop") => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }));
  const maxTokensOf = (f: ReturnType<typeof vi.fn>, i: number) => JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string).max_tokens;

  it("max_tokens floor 2000 on the Claude-via-NEAR-AI channel (adaptive thinking eats the budget); larger values pass through", async () => {
    const f = vi.fn(async () => chatResp("ok"));
    vi.stubGlobal("fetch", f);
    const p = new NearAIClaudeProvider("k");
    await p.complete({ system: "s", messages: [], maxTokens: 300 });
    await p.complete({ system: "s", messages: [] });
    await p.complete({ system: "s", messages: [], maxTokens: 3000 });
    expect([0, 1, 2].map((i) => maxTokensOf(f, i))).toEqual([2000, 2000, 3000]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty("reasoning_effort");
  });
  it("finish_reason=length with empty content → one retry with max_tokens 4000, then success", async () => {
    const f = vi.fn().mockResolvedValueOnce(chatResp("", "length")).mockResolvedValueOnce(chatResp("Which chain?"));
    vi.stubGlobal("fetch", f);
    expect(await new NearAIClaudeProvider("k").complete({ system: "s", messages: [], maxTokens: 300 })).toBe("Which chain?");
    expect(f).toHaveBeenCalledTimes(2);
    expect([maxTokensOf(f, 0), maxTokensOf(f, 1)]).toEqual([2000, 4000]);
  });
  it("still empty after the retry → throws; empty without length → throws without retry", async () => {
    const f = vi.fn(async () => chatResp("", "length"));
    vi.stubGlobal("fetch", f);
    await expect(new NearAIClaudeProvider("k").complete({ system: "s", messages: [] })).rejects.toThrow(/Claude via NEAR AI: empty completion \(finish_reason=length\)/);
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(async () => chatResp("", "stop"));
    vi.stubGlobal("fetch", g);
    await expect(new NearAIClaudeProvider("k").complete({ system: "s", messages: [] })).rejects.toThrow(/empty completion/);
    expect(g).toHaveBeenCalledTimes(1);
  });
  it("DeepSeek TEE channel unchanged: caller's max_tokens as-is, no retry", async () => {
    const f = vi.fn(async () => chatResp("", "length"));
    vi.stubGlobal("fetch", f);
    await expect(new NearAIProvider("k").complete({ system: "s", messages: [], maxTokens: 300 })).rejects.toThrow(/^NEAR AI: empty completion$/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(maxTokensOf(f, 0)).toBe(300);
  });
  it("errors are labelled as the NEAR AI Claude channel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 402 })));
    await expect(new NearAIClaudeProvider("k").complete({ system: "s", messages: [] })).rejects.toThrow(/^Claude via NEAR AI 402/);
  });
  it("isNonTeeModelId: Claude/GPT/Gemini ids are never TEE; NEAR AI open models are", () => {
    for (const id of ["anthropic/claude-sonnet-5-5", "claude-sonnet-5-5", "openai/gpt-5", "google/gemini-3-pro"]) expect(isNonTeeModelId(id, {})).toBe(true);
    for (const id of ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3-30B", "zai-org/GLM-5.3-Flash", "openai/gpt-oss-120b"]) expect(isNonTeeModelId(id, {})).toBe(false);
    expect(isNonTeeModelId("custom/x", { NEARAI_CLAUDE_MODEL: "custom/x" })).toBe(true);
    expect(new NearAIProvider("k", "anthropic/claude-sonnet-5-5").tee).toBe(false);
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
