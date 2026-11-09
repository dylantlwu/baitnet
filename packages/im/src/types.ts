import type {
  Annotation,
  AuditEntry,
  ChannelKind,
  Correction,
  EvalRun,
  ScamScriptDef,
  ScriptAnalysis,
  ScriptUpload,
  User,
} from "@baitnet/shared";
import type { ArenaManager } from "@baitnet/arena";

// ───────────────────────── channel adapter (Telegram now, Lark next) ─────────────────────────

export type ImKind = Exclude<ChannelKind, "web">;

export interface ImUser {
  /** Telegram user id / Lark open_id */
  externalId: string;
  username?: string;
  displayName?: string;
  /** IETF language code reported by the IM client (e.g. "zh-hans", "en") */
  langCode?: string;
}

/** A file the adapter can download on demand (photo, document). */
export interface FileRef {
  id: string;
  filename: string;
  mime?: string;
  size?: number;
  kind: "image" | "document";
}

export interface InMessage {
  chatId: string;
  messageId: string;
  user: ImUser;
  /** only 1:1 chats are served; group messages are dropped by the router */
  isPrivate: boolean;
  text?: string;
  /** several photos sent together (Telegram media group) arrive as ONE message */
  images?: FileRef[];
  file?: FileRef;
  replyToMessageId?: string;
}

export interface ButtonPress {
  chatId: string;
  messageId: string;
  user: ImUser;
  payload: string;
  /** to acknowledge the press (toast) */
  pressId: string;
}

export interface Button {
  text: string;
  /** ≤ 64 bytes (Telegram callback_data limit) */
  payload: string;
}

export interface OutMessage {
  text: string;
  /** inline keyboard rows */
  buttons?: Button[][];
  /** ask the client to open a reply box pointing at this message */
  forceReply?: { placeholder?: string };
  replyToMessageId?: string;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface ChannelHandlers {
  onMessage(m: InMessage): Promise<void> | void;
  onButton(b: ButtonPress): Promise<void> | void;
}

/**
 * One implementation per IM (TelegramAdapter, later LarkAdapter).
 * The router never sees platform payloads, only these shapes.
 */
export interface ChannelAdapter {
  readonly kind: ImKind;
  start(h: ChannelHandlers): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, m: OutMessage): Promise<{ messageId: string }>;
  /** "typing…" indicator (Telegram shows it ~5 s; the router refreshes it) */
  typing(chatId: string): Promise<void>;
  /** replace (or remove with null) the buttons under a message */
  editButtons(chatId: string, messageId: string, buttons: Button[][] | null): Promise<void>;
  /** replace text + buttons of a message (wizard steps, reviewed cards) */
  editMessage(chatId: string, messageId: string, m: OutMessage): Promise<void>;
  /** acknowledge a button press, optionally with a short toast */
  answerButton(pressId: string, toast?: string, alert?: boolean): Promise<void>;
  fetchFile(ref: FileRef): Promise<{ filename: string; mime?: string; data: Buffer }>;
  /** command menu; lang undefined = default (zh) */
  setCommands(cmds: BotCommand[], lang?: string): Promise<void>;
  me(): Promise<{ username?: string; name?: string }>;
}

// ───────────────────────── provided by backend B (docs/dev/im-contract.md) ─────────────────────────

export interface IdentityService {
  bindByCode(kind: ImKind, externalId: string, username: string | undefined, code: string): Promise<User | null>;
  userByBinding(kind: ImKind, externalId: string): Promise<User | null>;
  reviewers(kind: ImKind): Promise<{ user: User; externalId: string }[]>;
  consumeLlmQuota(userId: string): Promise<boolean>;
  audit(entry: Omit<AuditEntry, "at">): Promise<void>;
  /** /status: today's usage and limit */
  quota(userId: string): Promise<{ usedToday: number; limitPerDay: number }>;
}

export interface ChatSessionStore {
  get(kind: ChannelKind, chatId: string): Promise<string | undefined>;
  set(kind: ChannelKind, chatId: string, sessionId: string): Promise<void>;
  clear(kind: ChannelKind, chatId: string): Promise<void>;
}

/** The subset of @baitnet/training the IM layer calls (pass the module itself). */
export interface TrainingApi {
  addAnnotation(input: Omit<Annotation, "id" | "at">): Annotation;
  addCorrection(input: Omit<Correction, "id" | "at" | "review" | "reviewer">): Correction;
  getCorrection?(id: string): Correction | undefined;
  reviewCorrection(id: string, approve: boolean, reviewer: string): { correction: Correction; playbookVersion: number };
  listCorrections?(filter?: { review?: Correction["review"] }): Correction[];
  listEvalRuns?(): EvalRun[];
  getPlaybookVersion?(): number;
}

export interface ScriptLabApi {
  /** analyze AND store (so save/review work later); expertId comes from the bound user */
  analyzeUpload(u: ScriptUpload): Promise<ScriptAnalysis>;
  /** save the analysis' draft as an arena script */
  save(analysisId: string, opts: { expertId: string }): Promise<ScamScriptDef> | ScamScriptDef;
  /** reviewer approves/rejects an address found in an upload (optional; else the card links to the web console) */
  reviewDraft?(analysisId: string, draftIndex: number, approve: boolean, reviewer: string): Promise<{ review: string; chain?: string; address?: string; alertId?: number; txHash?: string; filteredReason?: string }>;
}

export interface ImDeps {
  identity: IdentityService;
  chats: ChatSessionStore;
  arena: ArenaManager;
  training: TrainingApi;
  scriptlab: ScriptLabApi;
  /** web console origin, used for links in cards */
  publicUrl: string;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** where offset / reminders / pending replies are kept (default data/im/state-<kind>.json) */
  stateFile?: string;
  /** tests: override the Telegram API origin */
  telegramApiBase?: string;
  /** tests: inject an adapter instead of building one from env */
  adapter?: ChannelAdapter;
  now?: () => Date;
  random?: () => number;
}
