import { afterEach, describe, expect, it, vi } from "vitest";
import { ARENA_MODELS, DEFAULT_ARENA_MODEL } from "@baitnet/shared";
import { NearAIProvider } from "@baitnet/agent";
import { ArenaManager, arenaModelId, arenaModelOptions, arenaModelTier, isArenaModelChoice, selectArenaModel } from "../src/index.js";
import { deps, fakeLLM, script, session } from "./helpers.js";

const LIVE = { BAITNET_MODE: "live", NEARAI_API_KEY: "nk" } as NodeJS.ProcessEnv;

afterEach(() => vi.unstubAllGlobals());

describe("D30 model choice → provider", () => {
  it("deepseek / glm → NEAR AI (TEE) with the ARENA_MODELS ids; haiku / sonnet → Claude via NEAR AI", () => {
    const d = selectArenaModel("deepseek", LIVE);
    expect(d.engine).toBe("nearai");
    expect(d.llm?.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
    expect(d.llm?.tee).toBe(true);
    const g = selectArenaModel("glm", LIVE);
    expect(g.engine).toBe("nearai");
    expect(g.llm?.model).toBe("z-ai/glm-5.3-flash");
    const h = selectArenaModel("haiku", LIVE);
    expect([h.engine, h.llm?.model, h.llm?.via, h.llm?.tee]).toEqual(["claude", "anthropic/claude-haiku-5-5", "nearai", false]);
    const s = selectArenaModel("sonnet", LIVE);
    expect([s.engine, s.llm?.model, s.llm?.via, s.llm?.tee]).toEqual(["claude", "anthropic/claude-sonnet-5-5", "nearai", false]);
  });

  it("Claude choices go direct with ANTHROPIC_API_KEY; deepseek/glm need the NEAR AI key", () => {
    const env = { BAITNET_MODE: "live", ANTHROPIC_API_KEY: "ak" } as NodeJS.ProcessEnv;
    expect(selectArenaModel("sonnet", env).llm).toMatchObject({ via: "anthropic", model: "claude-sonnet-5-5" });
    expect(selectArenaModel("haiku", env).llm).toMatchObject({ via: "anthropic", model: "claude-haiku-5-5" });
    expect(selectArenaModel("deepseek", env).engine).toBe("rules");
    expect(selectArenaModel("glm", env).engine).toBe("rules");
  });

  it("env overrides the model id; empty string falls back to the default", () => {
    const env = { ...LIVE, NEARAI_MODEL_DEEPSEEK: "x/ds", NEARAI_MODEL_GLM: "", NEARAI_CLAUDE_MODEL: "anthropic/s2", NEARAI_CLAUDE_HAIKU_MODEL: "anthropic/h2" };
    expect(arenaModelId("deepseek", env)).toBe("x/ds");
    expect(arenaModelId("glm", env)).toBe("z-ai/glm-5.3-flash");
    expect(selectArenaModel("sonnet", env).llm?.model).toBe("anthropic/s2");
    expect(selectArenaModel("haiku", env).llm?.model).toBe("anthropic/h2");
    expect(selectArenaModel("haiku", { BAITNET_MODE: "live", ANTHROPIC_API_KEY: "a", CLAUDE_HAIKU_MODEL: "claude-h-x" }).llm?.model).toBe("claude-h-x");
  });

  it("rules: offline, BAITNET_ARENA_ENGINE=rules, or no key", () => {
    for (const c of ["deepseek", "glm", "haiku", "sonnet"] as const) {
      expect(selectArenaModel(c, { BAITNET_MODE: "offline", NEARAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" }).engine).toBe("rules");
      expect(selectArenaModel(c, { ...LIVE, BAITNET_ARENA_ENGINE: "rules" }).engine).toBe("rules");
      expect(selectArenaModel(c, { BAITNET_MODE: "live" }).engine).toBe("rules");
    }
  });

  it("validation, default and price tiers", () => {
    expect(DEFAULT_ARENA_MODEL).toBe("deepseek");
    expect(isArenaModelChoice("glm")).toBe(true);
    expect(isArenaModelChoice("gpt")).toBe(false);
    expect(isArenaModelChoice(undefined)).toBe(false);
    expect(arenaModelTier("sonnet")).toBe("pricey");
    expect(arenaModelTier("glm")).toBe("cheapest");
    expect(arenaModelTier("deepseek")).toBe("cheap");
  });

  it("arenaModelOptions marks availability (no key → none, live → all)", () => {
    const none = arenaModelOptions({ BAITNET_MODE: "live" });
    expect(none.liveLLM).toBe(false);
    expect(none.models.map((m) => m.id)).toEqual(ARENA_MODELS.map((m) => m.id));
    expect(none.models.every((m) => !m.available)).toBe(true);
    const live = arenaModelOptions(LIVE);
    expect(live.default).toBe("deepseek");
    expect(live.models.every((m) => m.available)).toBe(true);
    expect(live.models.find((m) => m.id === "sonnet")?.via).toBe("nearai");
  });
});

describe("request bodies", () => {
  const reply = (content: string, finish = "stop") => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });

  it("deepseek sends chat_template_kwargs thinking:false; glm does not (it leaks reasoning) but gets ≥2000 tokens + retry", async () => {
    const bodies: any[] = [];
    const queue = [reply("嗯？"), reply("", "length"), reply("地址发我")];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), queue.shift()!)));
    const ds = selectArenaModel("deepseek", LIVE).llm as NearAIProvider;
    expect(await ds.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 300 })).toBe("嗯？");
    expect(bodies[0].chat_template_kwargs).toEqual({ thinking: false, enable_thinking: false });
    expect(bodies[0].max_tokens).toBe(300);
    const glm = selectArenaModel("glm", LIVE).llm!;
    expect(await glm.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 300 })).toBe("地址发我");
    expect(bodies[1].chat_template_kwargs).toBeUndefined();
    expect(bodies[1].max_tokens).toBe(2000);
    expect(bodies[2].max_tokens).toBe(4000);
  });

  it("haiku via NEAR AI uses the Claude floor (2000) and retries an empty length-cut reply", async () => {
    const bodies: any[] = [];
    const queue = [reply("", "length"), reply("好的")];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), queue.shift()!)));
    expect(await selectArenaModel("haiku", LIVE).llm!.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 300 })).toBe("好的");
    expect(bodies.map((b) => [b.model, b.max_tokens])).toEqual([["anthropic/claude-haiku-5-5", 2000], ["anthropic/claude-haiku-5-5", 4000]]);
  });
});

describe("session records modelChoice + model", () => {
  it("LLM engine: model = provider model; quota downgrade → rules, model cleared, choice kept", async () => {
    const { llm } = fakeLLM(() => "ok");
    let allow = true;
    const { eng } = session("fake-loan-02", { engine: "nearai", llm, modelChoice: "glm", llmGate: () => allow });
    expect(eng.session).toMatchObject({ engine: "nearai", modelChoice: "glm", model: "fake" });
    allow = false;
    await eng.step();
    expect(eng.session.engine).toBe("rules");
    expect(eng.session.model).toBeUndefined();
    expect(eng.session.modelChoice).toBe("glm");
  });

  it("rules engine: no model", () => {
    const { eng } = session("fake-loan-02", { modelChoice: "sonnet" });
    expect(eng.session.engine).toBe("rules");
    expect(eng.session.modelChoice).toBe("sonnet");
    expect("model" in eng.session).toBe(false);
  });

  it("ArenaManager.create: default deepseek, explicit choice, unknown → 400; env-driven provider", async () => {
    const mgr = new ArenaManager({ persist: false, scripts: [script("fake-loan-02")], registry: deps().registry, retriever: deps().retriever, env: LIVE });
    const a = await mgr.create("fake-loan-02");
    expect(a.session).toMatchObject({ engine: "nearai", modelChoice: "deepseek", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    const b = await mgr.create("fake-loan-02", {}, undefined, "haiku");
    expect(b.session).toMatchObject({ engine: "claude", modelChoice: "haiku", model: "anthropic/claude-haiku-5-5" });
    await expect(mgr.create("fake-loan-02", {}, undefined, "gpt" as never)).rejects.toMatchObject({ status: 400 });
    const off = new ArenaManager({ persist: false, scripts: [script("fake-loan-02")], registry: deps().registry, retriever: deps().retriever, env: { BAITNET_MODE: "offline", NEARAI_API_KEY: "k" } });
    const r = await off.create("fake-loan-02", {}, undefined, "glm");
    expect(r.session.engine).toBe("rules");
    expect(r.session.modelChoice).toBe("glm");
    expect(r.session.model).toBeUndefined();
    expect(off.models().liveLLM).toBe(false);
  });
});
