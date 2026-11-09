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

export interface LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  complete(req: CompletionRequest): Promise<string>;
}

export const NEARAI_BASE_URL = process.env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1";
export const DEFAULT_NEARAI_MODEL = process.env.NEARAI_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

/**
 * NEAR AI Cloud (OpenAI-compatible, models run in TEEs).
 * Privacy: prompts/answers are never written to plaintext logs by BaitNet; only
 * the encrypted evidence (data/evidence) and a PII-redacted copy are kept.
 */
export class NearAIProvider implements LLMProvider {
  readonly name = "nearai" as const;
  constructor(
    private apiKey: string,
    readonly model = DEFAULT_NEARAI_MODEL,
    private baseUrl = NEARAI_BASE_URL,
  ) {}
  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 400,
        temperature: 0.7,
        messages: [{ role: "system", content: req.system }, ...req.messages],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("NEAR AI: empty completion");
    return text;
  }
}

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude" as const;
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

/** nearai → claude → replay, picked by NEARAI_API_KEY / ANTHROPIC_API_KEY (override: BAITNET_LLM=replay|claude|nearai). */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const forced = (env.BAITNET_LLM || undefined) as LLMProviderName | undefined;
  // offline/testnet mode never calls an LLM API, even if keys are in the shell (D8)
  if (forced === "replay" || !allowLiveLLM(env)) return new ReplayProvider();
  if ((forced === "nearai" || !forced) && env.NEARAI_API_KEY) return new NearAIProvider(env.NEARAI_API_KEY, env.NEARAI_MODEL ?? DEFAULT_NEARAI_MODEL);
  if ((forced === "claude" || !forced) && env.ANTHROPIC_API_KEY) return new ClaudeProvider(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL);
  return new ReplayProvider();
}
