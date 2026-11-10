import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, LLMProviderName, ScamScript } from "@baitnet/shared";
import { fixturePath } from "../paths.js";
import { allowLiveLLM } from "../mode.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** For replay: which recorded turn is being asked for. */
  replay?: { script: ScamScript; turnIndex: number };
}

/**
 * Which network channel a provider actually talks to. "nearai" covers BOTH the TEE-hosted open
 * models (NearAIProvider) and Claude proxied by NEAR AI Cloud (NearAIClaudeProvider, Incognito tier:
 * account identity hidden, content still processed by Anthropic, NO TEE, NO attestation).
 */
export type LLMVia = "anthropic" | "nearai" | "local";

export interface LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  /** network channel (for logs/UI); absent on test fakes */
  readonly via?: LLMVia;
  /** true only for NEAR AI's self-hosted TEE models; Claude (any channel) is never TEE */
  readonly tee?: boolean;
  complete(req: CompletionRequest): Promise<string>;
}

// `||` (not `??`) for model/url env vars: .env.example ships `NEARAI_MODEL=` empty, which must mean "default", not model "".
export const NEARAI_BASE_URL = process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1";
/** Hard-coded NEAR AI TEE model (never read from env) — the safe fallback for zero-retention. */
export const NEARAI_TEE_FALLBACK_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const DEFAULT_NEARAI_MODEL = process.env.NEARAI_MODEL || NEARAI_TEE_FALLBACK_MODEL;
export const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
/**
 * Claude model id on NEAR AI Cloud (used when there is no ANTHROPIC_API_KEY).
 * Checked against GET /v1/models with a real key on 2026-11-09 (owned_by "anthropic", Incognito tier).
 */
export const DEFAULT_NEARAI_CLAUDE_MODEL = process.env.NEARAI_CLAUDE_MODEL || "anthropic/claude-sonnet-5-5";

/**
 * Model ids on NEAR AI Cloud that are proxied third-party models (Incognito tier, NOT TEE):
 * Claude / GPT / Gemini. Anything matching must never be treated as a TEE model.
 * (Zero-retention additionally requires owned_by "nearai" from /v1/models — see scriptlab ephemeral.ts.)
 */
export function isNonTeeModelId(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (id === (env.NEARAI_CLAUDE_MODEL || DEFAULT_NEARAI_CLAUDE_MODEL)) return true;
  // open-weight gpt-oss may be hosted by NEAR AI itself (TEE), so it is not excluded by name; /models metadata decides
  return /^anthropic\//i.test(id) || /claude|gemini/i.test(id) || /(^|\/)gpt-(?!oss)/i.test(id);
}

/** POST an OpenAI-compatible /chat/completions to NEAR AI Cloud; returns the first choice's text ("" if none) and finish_reason. */
async function nearaiChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  req: CompletionRequest,
  label: string,
  maxTokens = req.maxTokens ?? 400,
  extraBody: Record<string, unknown> = {},
): Promise<{ text: string; finishReason?: string }> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...extraBody,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  return { text: body.choices?.[0]?.message?.content?.trim() ?? "", finishReason: body.choices?.[0]?.finish_reason };
}

/**
 * Claude via NEAR AI thinks adaptively; thinking tokens count towards max_tokens but never appear in
 * content (max_tokens=300 → finish_reason "length" with empty content). A caller's smaller maxTokens is
 * the desired reply length (enforced by the system prompt), not the cap. reasoning_effort is rejected (400).
 */
export const NEARAI_CLAUDE_MIN_MAX_TOKENS = 2000;

/**
 * Turn off "thinking" on DeepSeek (D30: faster arena replies). Measured 2026-11-09/10 on DeepSeek V4.1
 * Flash: reasoning_tokens 0, ~2 s per reply. NOT for GLM 5.3 Flash: there `enable_thinking:false` does not
 * stop the thinking, it only moves the reasoning text into `content` (measured 2026-11-10) — so GLM gets
 * no kwargs and a bigger token budget instead (see GLM_OPTIONS in @baitnet/arena deps.ts).
 */
export const NO_THINKING = { chat_template_kwargs: { thinking: false, enable_thinking: false } } as const;

export interface NearAIOptions {
  /** extra request-body fields, e.g. NO_THINKING */
  extraBody?: Record<string, unknown>;
  /**
   * For models that always think (GLM): reasoning tokens count towards max_tokens, so a caller's small
   * maxTokens would end in an empty reply. Raise the cap to at least this, and retry once with twice
   * as much when the reply is empty with finish_reason "length".
   */
  minMaxTokens?: number;
}
export const NEARAI_CLAUDE_RETRY_MAX_TOKENS = 4000;

/**
 * NEAR AI Cloud (OpenAI-compatible, models run in TEEs).
 * Privacy: prompts/answers are never written to plaintext logs by BaitNet; only
 * the encrypted evidence (data/evidence) and a PII-redacted copy are kept.
 */
export class NearAIProvider implements LLMProvider {
  readonly name = "nearai" as const;
  readonly via = "nearai" as const;
  constructor(
    private apiKey: string,
    readonly model = DEFAULT_NEARAI_MODEL,
    private baseUrl = NEARAI_BASE_URL,
    readonly options: NearAIOptions = {},
  ) {}
  /** TEE unless NEARAI_MODEL was pointed at a proxied (Incognito) model such as Claude */
  get tee(): boolean {
    return !isNonTeeModelId(this.model);
  }
  async complete(req: CompletionRequest): Promise<string> {
    const { extraBody, minMaxTokens } = this.options;
    const first = minMaxTokens ? Math.max(req.maxTokens ?? 400, minMaxTokens) : undefined;
    let r = await nearaiChat(this.baseUrl, this.apiKey, this.model, req, "NEAR AI", first, extraBody);
    if (!r.text && first && r.finishReason === "length") r = await nearaiChat(this.baseUrl, this.apiKey, this.model, req, "NEAR AI", first * 2, extraBody);
    if (!r.text) throw new Error(`NEAR AI: empty completion${first && r.finishReason ? ` (finish_reason=${r.finishReason})` : ""}`);
    return r.text;
  }
}

/** Claude direct (api.anthropic.com, ANTHROPIC_API_KEY). Optional channel; not TEE. */
export class ClaudeProvider implements LLMProvider {
  readonly name = "claude" as const;
  readonly via = "anthropic" as const;
  readonly tee = false;
  constructor(
    private apiKey: string,
    readonly model = DEFAULT_CLAUDE_MODEL,
  ) {}
  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: req.maxTokens ?? 400, system: req.system, messages: req.messages }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    if (!text) throw new Error("Claude: empty completion");
    return text;
  }
}

/**
 * Claude via NEAR AI Cloud (OpenAI-compatible, NEARAI_API_KEY). Incognito tier only: NEAR AI hides
 * the account identity, but the content is processed by Anthropic — this is NOT a TEE and has NO
 * attestation. Never use it for zero-retention (packages/scriptlab/src/ephemeral.ts).
 */
export class NearAIClaudeProvider implements LLMProvider {
  readonly name = "claude" as const;
  readonly via = "nearai" as const;
  readonly tee = false;
  constructor(
    private apiKey: string,
    readonly model = DEFAULT_NEARAI_CLAUDE_MODEL,
    private baseUrl = NEARAI_BASE_URL,
  ) {}
  async complete(req: CompletionRequest): Promise<string> {
    const label = "Claude via NEAR AI";
    const first = Math.max(req.maxTokens ?? 400, NEARAI_CLAUDE_MIN_MAX_TOKENS);
    let r = await nearaiChat(this.baseUrl, this.apiKey, this.model, req, label, first);
    // thinking used up the budget before any visible text → one retry with a bigger budget
    if (!r.text && r.finishReason === "length") r = await nearaiChat(this.baseUrl, this.apiKey, this.model, req, label, Math.max(first, NEARAI_CLAUDE_RETRY_MAX_TOKENS));
    if (!r.text) throw new Error(`${label}: empty completion${r.finishReason ? ` (finish_reason=${r.finishReason})` : ""}`);
    return r.text;
  }
}

/** The "claude" engine: ANTHROPIC_API_KEY → direct; else NEARAI_API_KEY → Claude via NEAR AI (Incognito); else undefined. */
/** `models` picks another Claude (e.g. D30 Haiku): `direct` for api.anthropic.com, `nearai` for NEAR AI Cloud. */
export function selectClaudeProvider(env: NodeJS.ProcessEnv = process.env, models: { direct?: string; nearai?: string } = {}): ClaudeProvider | NearAIClaudeProvider | undefined {
  if (env.ANTHROPIC_API_KEY) return new ClaudeProvider(env.ANTHROPIC_API_KEY, models.direct || env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL);
  if (env.NEARAI_API_KEY) return new NearAIClaudeProvider(env.NEARAI_API_KEY, models.nearai || env.NEARAI_CLAUDE_MODEL || DEFAULT_NEARAI_CLAUDE_MODEL, env.NEARAI_BASE_URL || NEARAI_BASE_URL);
  return undefined;
}

export interface ReplayFixture extends Conversation {
  language?: string;
  note?: string;
}

export function loadReplayFixtures(dir = fixturePath("conversations")): Map<ScamScript, ReplayFixture> {
  const m = new Map<ScamScript, ReplayFixture>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as ReplayFixture;
    if (!m.has(c.script)) m.set(c.script, c);
  }
  return m;
}

/** Deterministic: returns recorded turns from fixtures/conversations/*.json. */
export class ReplayProvider implements LLMProvider {
  readonly name = "replay" as const;
  readonly model = "replay";
  readonly via = "local" as const;
  readonly fixtures: Map<ScamScript, ReplayFixture>;
  constructor(dir?: string) {
    this.fixtures = loadReplayFixtures(dir);
  }
  fixture(script: ScamScript): ReplayFixture {
    const f = this.fixtures.get(script);
    if (!f) throw new Error(`no replay fixture for script "${script}" in fixtures/conversations`);
    return f;
  }
  async complete(req: CompletionRequest): Promise<string> {
    if (!req.replay) throw new Error("ReplayProvider needs req.replay {script, turnIndex}");
    const t = this.fixture(req.replay.script).turns[req.replay.turnIndex];
    if (!t) throw new Error(`replay: no turn ${req.replay.turnIndex} for ${req.replay.script}`);
    return t.text;
  }
}

/**
 * nearai (TEE) → claude → replay, picked by NEARAI_API_KEY / ANTHROPIC_API_KEY (override: BAITNET_LLM=replay|claude|nearai).
 * "claude" = direct with ANTHROPIC_API_KEY, else via NEAR AI with NEARAI_API_KEY — so with only a NEAR AI
 * key the default is still the TEE model, and BAITNET_LLM=claude switches to Claude via NEAR AI.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const forced = (env.BAITNET_LLM || undefined) as LLMProviderName | undefined;
  // offline/testnet mode never calls an LLM API, even if keys are in the shell (D8)
  if (forced === "replay" || !allowLiveLLM(env)) return new ReplayProvider();
  if ((forced === "nearai" || !forced) && env.NEARAI_API_KEY) return new NearAIProvider(env.NEARAI_API_KEY, env.NEARAI_MODEL || DEFAULT_NEARAI_MODEL);
  if (forced === "claude" || !forced) return selectClaudeProvider(env) ?? new ReplayProvider();
  return new ReplayProvider();
}
