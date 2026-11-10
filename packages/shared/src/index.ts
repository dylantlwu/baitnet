/**
 * BaitNet shared contract between all apps.
 * Owner: product. Change docs/01_功能模块.md §4 first, then this file.
 */

export type Chain = "near" | "evm" | "tron" | "btc";
export type Level = "L1" | "L2" | "L3";
export type AlertStatus = "Active" | "Disputed" | "Revoked";
export type VerdictKind = "allow" | "warn" | "block";
export type AckOutcome = "Seen" | "Blocked" | "Reported";
export type LLMProviderName = "nearai" | "claude" | "replay";
export type ScamScript = "investment" | "pig-butchering" | "fake-support";

export interface Turn {
  role: "scammer" | "bait";
  text: string;
  ts: string; // ISO 8601
}

export interface Conversation {
  id: string;
  script: ScamScript;
  provider: LLMProviderName;
  turns: Turn[];
}

/** Output of M2 before it goes on chain. */
export interface AlertDraft {
  chain: Chain;
  address: string;
  level: Level;
  category: ScamScript | string;
  evidenceHash: string; // hex sha256 of plaintext evidence
  conversationId: string;
  /** Set when the anti-poisoning filter dropped it; such drafts never go on chain. */
  filteredReason?: string;
}

/** Shape returned by AlertRegistry views, normalized for TS. */
export interface AlertView {
  id: number;
  chain: Chain;
  address: string;
  level: Level;
  category: string;
  evidenceHash: string;
  status: AlertStatus;
  reporter: string;
  createdAt: string; // ISO 8601 (contract stores ns timestamp as string)
  updatedAt?: string;
  /** All evidence hashes appended to this alert (first one == evidenceHash). */
  evidenceHashes?: string[];
  statusReasonHash?: string | null;
  /** Off-chain link to the decoy conversation (not stored on chain). */
  conversationId?: string;
  txHash?: string;
}

/**
 * Evidence plaintext is a canonical JSON string; evidenceHash = hex(sha256(utf8(plaintext))).
 * GET /alerts/:id/evidence returns this. Demo data only — the UI redacts phones/handles on display.
 */
export interface EvidenceResponse {
  alertId: number;
  plaintext: string;
}

export interface Ack {
  alertId: number;
  responder: string;
  outcome: AckOutcome;
  at: string;
  /** When the responder's subscriber first saw the alert (off-chain, self-reported). */
  receivedAt?: string;
}

export interface Responder {
  accountId: string;
  name: string;
  registeredAt: string;
}

export interface Target {
  chain: Chain;
  address: string;
}

export interface VerdictReason {
  signal:
    | "registry-l1"
    | "registry-l2-or-disputed"
    | "young-account"
    | "contract-code-changed"
    | "no-prior-interaction";
  detail: string;
  weight: number;
}

export interface Verdict {
  kind: VerdictKind;
  target: Target;
  reasons: VerdictReason[];
  alert?: AlertView;
  checkedAt: string;
}

export interface GuardEvent {
  id: string;
  source: "agent-wallet" | "intents-solver";
  verdict: Verdict;
  action: "signed" | "refused" | "asked-human" | "quote-refused" | "quoted";
  log: string[];
  at: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  protocol: string; // e.g. "near-intents-1click", "transfer", "bridge"
  chain: Chain;
  amountUsd?: number;
  ts: string;
  txHash?: string;
}

export interface AttestationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface AttestationResult {
  model: string;
  nonce: string;
  signingAddress?: string;
  checks: AttestationCheck[];
  verified: boolean;
  recorded: boolean; // true when served from fixtures (offline mode)
  at: string;
}

/** Everything the dashboard needs; also the static snapshot format (apps/web/public/snapshot.json). */
export interface DemoSnapshot {
  generatedAt: string;
  network: "sandbox" | "testnet" | "memory";
  registryContract: string;
  alerts: AlertView[];
  conversations: Conversation[];
  events: GuardEvent[];
  flows: Record<number, FlowEdge[]>; // keyed by alert id
  responders: Responder[];
  acks: Ack[];
  attestation?: AttestationResult;
  /** Evidence plaintext keyed by alert id (demo data only). */
  evidence?: Record<number, string>;
  /** Recorded arena sessions for replay on the static hosted page. */
  arenaSessions?: ArenaSession[];
  /** Script catalog (title/type/lang) so hosted replay can label sessions. */
  arenaScripts?: Pick<ScamScriptDef, "id" | "type" | "lang" | "title">[];
  eval?: EvalReport;
  evalRuns?: EvalRun[];
  playbook?: PlaybookEntry[];
  corrections?: Correction[];
}

// ───────────────────────── M11 Arena ─────────────────────────

export type ScamType =
  | "investment"
  | "pig-butchering"
  | "fake-support"
  | "fake-airdrop"
  | "task-scam"
  | "exchange-impersonation"
  | "fake-nft-mint"
  | "family-emergency"
  | "fake-loan"
  | "recovery-scam";

/** A scam script the scammer AI improvises around (fixtures/scripts/*.json). Fictional data only. */
export interface ScamScriptDef {
  id: string; // e.g. "investment-01"
  type: ScamType;
  lang: "zh" | "en";
  title: string;
  persona: string; // who the scammer pretends to be
  hook: string; // opening move
  goal: string; // what the scammer wants the victim to do
  stages: { name: string; objective: string; sampleLines: string[] }[];
  objections: { victimSays: string; scammerCounters: string[] }[];
  /** What a successful decoy should extract. Addresses are fictional but format-valid. */
  plantedArtifacts: { kind: "address" | "url" | "phone" | "handle"; chain?: Chain; value: string; /** 0-based index into `stages`; the value appears verbatim in that stage's sampleLines. */ revealAtStage: number }[];
  /** Lines that try to hijack the decoy AI (prompt injection). */
  injections: string[];
  /** Poison variant: the "payment address" is actually a known entity / innocent address; M2 must filter it. */
  poison?: { address: string; chain: Chain; why: string };
  source: "original" | { citation: string };
}

export type ArenaSide = "scammer" | "bait";
export type SideMode = "ai" | "human" | "ai+whisper";
export type ArenaEngine = "nearai" | "claude" | "rules";

/**
 * D30: the model an expert picks for the AI sides of a session (web + IM). All go through
 * NEAR AI Cloud with one key. Default = cheapest. `tee` = runs in NEAR AI's own TEE
 * (owned_by "nearai"); Sonnet is the Incognito tier (not TEE, no attestation).
 */
export type ArenaModelChoice = "deepseek" | "glm" | "haiku" | "sonnet";
export interface ArenaModelInfo {
  id: ArenaModelChoice;
  /** NEAR AI Cloud model id (overridable server-side by env). */
  model: string;
  label: string;
  tee: boolean;
  /** USD per 1M tokens, input / output (NEAR AI list price, checked 2026-11-09). */
  price: { input: number; output: number };
  /** Measured 2026-11-10: always reasons before answering (cannot be switched off) → 7–28 s per reply, extra billed tokens. */
  slow?: true;
}
export const ARENA_MODELS: readonly ArenaModelInfo[] = [
  { id: "deepseek", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", label: "DeepSeek V4.1 Flash", tee: true, price: { input: 0.3, output: 1.2 } },
  { id: "glm", model: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", tee: true, price: { input: 0.08, output: 0.5 }, slow: true },
  { id: "haiku", model: "anthropic/claude-haiku-5-5", label: "Claude Haiku 5.5", tee: false, price: { input: 0.1, output: 0.5 } },
  { id: "sonnet", model: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", tee: false, price: { input: 2, output: 10 } },
] as const;
export const DEFAULT_ARENA_MODEL: ArenaModelChoice = "deepseek";

export interface ArenaTurn {
  index: number;
  side: ArenaSide;
  text: string;
  author: "ai" | "human";
  /** Whisper the AI received before producing this turn (only visible to operators). */
  whisper?: string;
  /** Set when the bait-safety filter rewrote/blocked the AI's draft. */
  safety?: { blocked: boolean; rule: string; original?: string };
  ts: string;
}

export interface ArenaSession {
  id: string;
  scriptId: string;
  engine: ArenaEngine;
  /** D30: which model the expert picked (absent on sessions created before D30 = default). */
  modelChoice?: ArenaModelChoice;
  /** Concrete model id used for the AI sides (absent in rules mode). */
  model?: string;
  modes: Record<ArenaSide, SideMode>;
  status: "running" | "paused" | "finished";
  turns: ArenaTurn[];
  drafts: (AlertDraft & { review: "pending" | "approved" | "rejected"; alertId?: number; txHash?: string })[];
  /** Expert's overall rating when the session ends (training mode). */
  rating?: SessionRating;
  /** Where this session is played (web / Telegram / Lark) and by whom. */
  channel?: SessionChannel;
  createdAt: string;
}

export type ArenaEvent =
  | { type: "turn"; sessionId: string; turn: ArenaTurn }
  | { type: "draft"; sessionId: string; draftIndex: number; draft: ArenaSession["drafts"][number] }
  | { type: "mode"; sessionId: string; side: ArenaSide; mode: SideMode }
  | { type: "status"; sessionId: string; status: ArenaSession["status"] }
  | { type: "onchain"; sessionId: string; draftIndex: number; alertId: number; txHash?: string }
  | { type: "safety"; sessionId: string; side: ArenaSide; rule: string; turnIndex?: number };

export interface SessionRating {
  expertId: string;
  score: 1 | 2 | 3 | 4 | 5;
  note: string;
  at: string;
}

export interface EvalCase {
  scriptId: string;
  type: ScamType;
  lang?: Lang;
  engine: ArenaEngine;
  turns: number;
  extracted: boolean; // got the planted payment address
  turnsToExtract?: number;
  leaked: boolean; // bait revealed PII / seed / agreed to pay / clicked link
  hijacked: boolean; // bait followed an injection
  poisonFiltered?: boolean; // only for poison variants
  onChain: boolean; // extracted address reported to registry
  notes: string[];
}

export interface EvalReport {
  generatedAt: string;
  engine: ArenaEngine;
  cases: EvalCase[];
  summary: {
    total: number;
    extracted: number;
    leaked: number;
    hijacked: number;
    poisonTotal: number;
    poisonFiltered: number;
    onChain: number;
    avgTurnsToExtract: number;
  };
  /** Same metrics split by script language (zh is first-class, D16). */
  summaryByLang?: Partial<Record<Lang, EvalReport["summary"]>>;
  /** Expert-correction regression cases (M12). */
  regression?: { total: number; passed: number; cases: { id: string; scriptId: string; pass: boolean; reply: string; reasons?: string[] }[] };
  playbookVersion?: number;
  /** scriptId -> script language */
  lang?: Record<string, Lang>;
}

// ───────────────────────── M12 Training ─────────────────────────

export type TurnRating = "good" | "bad" | "risky";

export interface Annotation {
  id: string;
  sessionId: string;
  turnIndex: number; // bait turns only
  expertId: string;
  rating: TurnRating;
  tags: string[]; // tactic tags, e.g. "stalling", "ask-address", "resist-injection"
  note: string;
  at: string;
}

export interface Correction {
  id: string;
  sessionId: string;
  turnIndex: number; // the bait turn being corrected
  expertId: string;
  scriptId: string;
  scamType: ScamType;
  stage: number;
  situation: string; // short description of what the scammer just did
  badReply: string;
  goodReply: string;
  rationale: string;
  tags: string[];
  review: "pending" | "approved" | "rejected";
  reviewer?: string;
  at: string;
}

export interface PlaybookEntry {
  id: string;
  version: number; // playbook version this entry was added in
  scamType: ScamType | "any";
  stage: number | "any";
  situation: string;
  badReply?: string;
  goodReply: string;
  rationale: string;
  tags: string[];
  sourceCorrectionId?: string;
}

/** Retrieval contract; TagRetriever now, VectorRetriever later. */
export interface PlaybookQuery {
  scamType: ScamType;
  stage: number;
  lastScammerText: string;
  tags?: string[];
  k?: number;
}

export interface EvalRun {
  id: string;
  playbookVersion: number;
  engine: ArenaEngine;
  at: string;
  summary: EvalReport["summary"] & { regressionTotal: number; regressionPassed: number };
}

// ───────────────────────── M13 Script Lab ─────────────────────────

export type Lang = "zh" | "en";
export type UploadFormat = "text" | "markdown" | "scam-script-json" | "telegram-json" | "whatsapp-txt" | "image";
export type AnalysisEngine = "nearai" | "claude" | "rules";

export interface ScriptUpload {
  filename: string;
  /** UTF-8 text, or base64 for images. */
  content: string;
  encoding: "utf8" | "base64";
  /** Ignored server-side: identity comes from the authenticated user (or "local-expert"). */
  expertId: string;
  langHint?: Lang;
  /** Multiple files (e.g. a sequence of phone screenshots), transcribed in order and de-duplicated. Max 20, 5MB each. */
  files?: { filename: string; content: string; encoding: "utf8" | "base64" }[];
}

export interface PiiFinding {
  kind: "name" | "phone" | "email" | "id-number" | "bank-card" | "address-postal" | "handle";
  placeholder: string; // e.g. "[PHONE_1]"
  count: number;
}

export interface ScriptAnalysis {
  id: string;
  filename: string;
  format: UploadFormat;
  lang: Lang;
  engine: AnalysisEngine;
  redactedText: string; // only the redacted version is ever shown/stored in clear
  pii: PiiFinding[];
  scamType: { value: ScamType; confidence: number; alternatives: { value: ScamType; confidence: number }[] };
  stages: { name: string; fromLine: number; toLine: number; tactics: string[] }[];
  artifacts: ScamScriptDef["plantedArtifacts"];
  injections: string[];
  draft: ScamScriptDef;
  alertDrafts: AlertDraft[]; // real addresses found -> human review before chain
  /** D27 zero-retention analysis: nothing was written server-side. */
  ephemeral?: true;
  /** Attestation for the TEE model call that produced this analysis (zero-retention mode). */
  attestation?: AttestationResult;
  /** sha256 of the sealed public evidence record (kind "script-upload"); original stays encrypted in data/evidence. */
  evidenceHash?: string;
  warnings: string[];
  at: string;
}

// ───────────────────────── D20 Auth (only when BAITNET_AUTH=on) ─────────────────────────

export type Role = "expert" | "reviewer";

export interface Me {
  authEnabled: boolean; // false locally: everyone is an implicit reviewer named by localStorage expertId
  expertId: string;
  name: string;
  role: Role;
  llmQuota?: { usedToday: number; limitPerDay: number };
}

export interface Invite {
  code: string; // shown once at creation
  name: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  usedAt?: string;
  revoked?: boolean;
  /** One-tap login link for phones: `${origin}/#/login?code=...` (also rendered as a QR code). */
  loginUrl?: string;
  /** Telegram deep link `https://t.me/<bot>?start=<code>` when a bot is configured. */
  telegramStartUrl?: string;
}

export interface AuditEntry {
  at: string;
  expertId: string;
  action: string; // e.g. "arena.say", "training.review", "scripts.upload", "alert.review"
  target?: string;
  detail?: string;
}

// ───────────────────────── D23 IM training (Telegram first, then Lark) ─────────────────────────

export type ChannelKind = "web" | "telegram" | "lark";

/** An IM account bound to a BaitNet user via `/start <invite code>`. */
export interface IdentityBinding {
  kind: Exclude<ChannelKind, "web">;
  externalId: string; // Telegram user id / Lark open_id
  username?: string;
  boundAt: string;
}

export interface User {
  id: string;
  name: string;
  role: Role;
  bindings: IdentityBinding[];
  createdAt: string;
}

/** Which side the human expert plays in an IM session (D24). */
export type ExpertPlays = "scammer" | "bait" | "observer";

export interface SessionChannel {
  kind: ChannelKind;
  chatId?: string; // IM chat id; absent for web
  ownerId: string; // User.id (or "local-expert" when auth is off)
  expertPlays?: ExpertPlays;
}

/** Backend HTTP API (apps/server), port 8787. */
export const API = {
  alerts: "/alerts",
  evidence: (id: number) => `/alerts/${id}/evidence`,
  check: "/check", // ?chain=&address=
  events: "/events", // SSE stream of GuardEvent
  flows: (alertId: number) => `/flows/${alertId}`,
  responders: "/responders",
  attestation: "/attestation",
  snapshot: "/snapshot",
  arenaScripts: "/arena/scripts",
  arenaSessions: "/arena/sessions",
  arenaSession: (id: string) => `/arena/sessions/${id}`,
  arenaEvents: (id: string) => `/arena/sessions/${id}/events`,
  arenaControl: (id: string) => `/arena/sessions/${id}/control`,
  arenaMode: (id: string) => `/arena/sessions/${id}/mode`,
  arenaSay: (id: string) => `/arena/sessions/${id}/say`,
  arenaWhisper: (id: string) => `/arena/sessions/${id}/whisper`,
  arenaReview: (id: string) => `/arena/sessions/${id}/review`,
  evalLatest: "/eval/latest",
  evalRuns: "/eval/runs", // EvalRun[] for the improvement curve
  annotations: "/training/annotations", // POST Annotation (without id/at), GET ?sessionId=
  corrections: "/training/corrections", // POST, GET ?review=
  correctionReview: (id: string) => `/training/corrections/${id}/review`, // POST {approve, reviewer}
  playbook: "/training/playbook", // GET PlaybookEntry[]
  playbookSearch: "/training/playbook/search", // POST PlaybookQuery -> PlaybookEntry[]
  scriptUpload: "/scripts/upload", // POST ScriptUpload -> ScriptAnalysis
  scriptAnalysis: (id: string) => `/scripts/analyses/${id}`,
  scriptSave: (id: string) => `/scripts/analyses/${id}/save`, // POST {draft: ScamScriptDef} -> saved script
  scriptAnalyzeEphemeral: "/scripts/analyze-ephemeral", // POST ScriptUpload -> ScriptAnalysis (ephemeral, nothing stored)
  scriptReview: (id: string) => `/scripts/analyses/${id}/review`, // POST {draftIndex, approve} -> alert draft review / on-chain
  arenaRate: (id: string) => `/arena/sessions/${id}/rate`, // POST Omit<SessionRating,"at">
  authLogin: "/auth/login", // POST {code} -> Me, sets httpOnly cookie
  authLogout: "/auth/logout", // POST
  authMe: "/auth/me", // GET -> Me (authEnabled=false locally)
  adminInvites: "/admin/invites", // reviewer: GET Invite[] (codes masked), POST {name, role} -> Invite (code shown once)
  adminInviteRevoke: (code: string) => `/admin/invites/${code}/revoke`,
  adminUsers: "/admin/users", // reviewer: GET User[] (with IM bindings)
  adminAudit: "/admin/audit", // reviewer: GET AuditEntry[]
} as const;

export const SERVER_PORT = 8787;
