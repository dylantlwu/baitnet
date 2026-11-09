import type {
  Annotation,
  ArenaEvent,
  ArenaSession,
  ArenaSide,
  ArenaTurn,
  Correction,
  EvalReport,
  EvalRun,
  PlaybookEntry,
  ScamScriptDef,
  ScriptAnalysis,
  ScriptUpload,
  SideMode,
} from "@baitnet/shared";

/**
 * One interface for everything the Arena / Training / Eval pages talk to.
 * - http:   real backend (apps/server)
 * - mock:   in-browser rules engine (dev without backend, or ?backend=mock)
 * - replay: hosted static snapshot, read-only
 */
export type BackendKind = "http" | "mock" | "replay";

export interface Backend {
  kind: BackendKind;
  readOnly: boolean;
  // Arena
  listScripts(): Promise<ScamScriptDef[]>;
  listRecordedSessions(): Promise<ArenaSession[]>;
  /** Full session (all channels: web / Telegram / Lark). */
  getSession(sessionId: string): Promise<ArenaSession>;
  createSession(scriptId: string, modes: Record<ArenaSide, SideMode>): Promise<ArenaSession>;
  subscribe(sessionId: string, onEvent: (e: ArenaEvent) => void): () => void;
  control(sessionId: string, action: "run" | "pause" | "step"): Promise<void>;
  setMode(sessionId: string, side: ArenaSide, mode: SideMode): Promise<void>;
  /** Resolves with the created turn when the server returns it (lets the UI confirm before SSE arrives). */
  say(sessionId: string, side: ArenaSide, text: string): Promise<ArenaTurn | void>;
  whisper(sessionId: string, side: ArenaSide, text: string): Promise<void>;
  review(sessionId: string, draftIndex: number, approve: boolean): Promise<void>;
  // Training
  postAnnotation(a: Omit<Annotation, "id" | "at">): Promise<Annotation>;
  postCorrection(c: Omit<Correction, "id" | "at" | "review" | "reviewer">): Promise<Correction>;
  listCorrections(): Promise<Correction[]>;
  reviewCorrection(id: string, approve: boolean, reviewer: string): Promise<Correction>;
  getPlaybook(): Promise<PlaybookEntry[]>;
  // Eval
  getEval(): Promise<EvalReport | undefined>;
  getEvalRuns(): Promise<EvalRun[]>;
  // Script Lab
  /** ephemeral = D27 zero-retention analysis in the TEE: nothing is stored server-side. */
  upload(u: ScriptUpload, opts?: { ephemeral?: boolean }): Promise<ScriptAnalysis>;
  /** For an ephemeral analysis the server has nothing stored, so the analysis travels back with the draft. */
  saveScript(analysisId: string, draft: ScamScriptDef, analysis?: ScriptAnalysis): Promise<ScamScriptDef>;
  /** Not in the shared API yet: review an AlertDraft found in an uploaded chat. */
  reviewUploadDraft(analysisId: string, draftIndex: number, approve: boolean): Promise<{ alertId?: number; txHash?: string }>;
}

export class ReadOnlyError extends Error {
  constructor() {
    super("read-only");
    this.name = "ReadOnlyError";
  }
}
