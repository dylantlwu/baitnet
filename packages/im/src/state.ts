import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelKind } from "@baitnet/shared";
import type { ChatSessionStore } from "./types.js";

/** What the router must remember across restarts (small; one JSON file per channel). */
export interface ImStateData {
  offset?: number;
  /** externalIds that already got the one "please bind first" reply */
  nagged: string[];
  /** failed /start attempts per externalId per day (brute-force guard) */
  bindFails: Record<string, { day: string; n: number }>;
  /** userId → day (Asia/Shanghai) of the last privacy reminder */
  privacy: Record<string, string>;
  /** userId → private chatId (to notify an expert when a reviewer acts) */
  userChat: Record<string, string>;
  /** chatId → what the next plain text means */
  pending: Record<string, Pending>;
  /** sessionId → view mode the expert chose with /mode */
  view: Record<string, "human" | "ai" | "observer">;
  /** sessions whose quota downgrade was announced */
  downgraded: string[];
  /** review card key → messages carrying it (so every reviewer's copy gets updated) */
  cards: Record<string, { chatId: string; messageId: string; text: string }[]>;
  /** userId → language of their IM client */
  userLang: Record<string, "zh" | "en">;
  /** arena drafts already announced (`${sid}:${idx}`) */
  announced: string[];
  /** analysisId → uploader userId */
  uploads: Record<string, string>;
  /** last daily digest day */
  digestDay?: string;
}

export type Pending =
  | { kind: "edit"; sessionId: string; turnIndex: number; promptId: string; at: string }
  | { kind: "note"; sessionId: string; score: number; promptId: string; at: string };

const empty = (): ImStateData => ({
  nagged: [],
  bindFails: {},
  privacy: {},
  userChat: {},
  pending: {},
  view: {},
  downgraded: [],
  cards: {},
  userLang: {},
  announced: [],
  uploads: {},
});

/** JSON file with atomic writes; in-memory when path is undefined. */
export class ImState {
  data: ImStateData;
  constructor(private path?: string) {
    this.data = empty();
    if (path && existsSync(path)) {
      try {
        this.data = { ...empty(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ImStateData>) };
      } catch {
        /* corrupt file: start fresh rather than crash the bot */
      }
    }
  }
  save() {
    if (!this.path) return;
    // keep the bounded lists bounded
    if (this.data.announced.length > 5000) this.data.announced = this.data.announced.slice(-2000);
    if (this.data.nagged.length > 5000) this.data.nagged = this.data.nagged.slice(-2000);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
  update(fn: (d: ImStateData) => void) {
    fn(this.data);
    this.save();
  }
}

/** Memory ChatSessionStore (tests); backend B ships the persistent one. */
export class MemoryChatSessionStore implements ChatSessionStore {
  private m = new Map<string, string>();
  async get(kind: ChannelKind, chatId: string) {
    return this.m.get(`${kind}:${chatId}`);
  }
  async set(kind: ChannelKind, chatId: string, sessionId: string) {
    this.m.set(`${kind}:${chatId}`, sessionId);
  }
  async clear(kind: ChannelKind, chatId: string) {
    this.m.delete(`${kind}:${chatId}`);
  }
}

/** File-backed ChatSessionStore for the standalone dev runner. */
export class FileChatSessionStore implements ChatSessionStore {
  private m: Record<string, string> = {};
  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.m = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.m = {};
      }
    }
  }
  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.m, null, 2));
  }
  async get(kind: ChannelKind, chatId: string) {
    return this.m[`${kind}:${chatId}`];
  }
  async set(kind: ChannelKind, chatId: string, sessionId: string) {
    this.m[`${kind}:${chatId}`] = sessionId;
    this.flush();
  }
  async clear(kind: ChannelKind, chatId: string) {
    delete this.m[`${kind}:${chatId}`];
    this.flush();
  }
}

/** Calendar day / hour in Asia/Shanghai (UTC+8, no DST). */
export function shanghai(d: Date): { day: string; hour: number } {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return { day: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}
