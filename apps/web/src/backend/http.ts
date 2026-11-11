import { API, type ArenaTurn, type ArenaSession, type Correction, type EvalReport, type EvalRun, type PlaybookEntry, type ScamScriptDef, type ScriptAnalysis } from "@baitnet/shared";
import type { ArenaModelsInfo, ArenaStreamEvent, Backend } from "./types";
import { normalizeScripts } from "./normalize";
import { noteLlmUse } from "../lib/quota";

export class HttpError extends Error {
  /** `body` = the parsed JSON error body when there was one (e.g. D33 409 lists the warning codes). */
  constructor(public status: number, msg: string, public body?: unknown) {
    super(msg);
    this.name = "HttpError";
  }
}

const unwrap = <T>(v: unknown, key: string): T => {
  if (v && typeof v === "object" && !Array.isArray(v) && key in (v as object)) return (v as Record<string, T>)[key];
  return v as T;
};

export function parseArenaEvent(data: string): ArenaStreamEvent | null {
  try {
    const v = JSON.parse(data) as ArenaStreamEvent;
    return v && typeof v === "object" && typeof v.type === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Stream events that mean the server may just have spent LLM quota: an AI-written turn. */
export const spendsQuota = (ev: ArenaStreamEvent) => ev.type === "turn" && (ev as { turn?: { author?: string } }).turn?.author === "ai";

export function createHttpBackend(apiBase: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Backend {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(apiBase + path, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      let body: unknown;
      try {
        body = JSON.parse(text);
        msg = (body as { error?: string } | null)?.error ?? text;
      } catch {
        /* plain text */
      }
      throw new HttpError(res.status, msg || `HTTP ${res.status}`, body);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const get = <T>(p: string) => req<T>("GET", p);
  const post = <T>(p: string, b: unknown = {}) => req<T>("POST", p, b);

  return {
    kind: "http",
    readOnly: false,
    listScripts: async () => normalizeScripts(unwrap<unknown>(await get(API.arenaScripts), "scripts")),
    listRecordedSessions: async () => {
      try {
        return unwrap<ArenaSession[]>(await get(API.arenaSessions), "sessions") ?? [];
      } catch {
        return [];
      }
    },
    getSession: (id) => get<ArenaSession>(API.arenaSession(id)),
    createSession: (scriptId, modes, modelChoice) =>
      post<ArenaSession>(API.arenaSessions, { scriptId, scammer: modes.scammer, bait: modes.bait, ...(modelChoice ? { modelChoice } : {}) }),
    // not in the shared API table (packages/shared is frozen for this change): D30 route
    listModels: () => get<ArenaModelsInfo>("/arena/models"),
    subscribe(id, onEvent) {
      const es = new EventSource(apiBase + API.arenaEvents(id), { withCredentials: true });
      const handler = (e: MessageEvent<string>) => {
        const ev = parseArenaEvent(e.data);
        if (!ev) return;
        onEvent(ev);
        if (spendsQuota(ev)) noteLlmUse();
      };
      es.onmessage = handler;
      for (const t of ["turn", "draft", "mode", "status", "onchain", "safety", "typing"]) es.addEventListener(t, handler as EventListener);
      return () => es.close();
    },
    control: (id, action) => post(API.arenaControl(id), { action }),
    setMode: (id, side, mode) => post(API.arenaMode(id), { side, mode }),
    say: async (id, side, text) => {
      const r = await post<unknown>(API.arenaSay(id), { side, text });
      const turn = unwrap<ArenaTurn | undefined>(r, "turn");
      return turn && typeof turn === "object" && typeof turn.index === "number" && typeof turn.text === "string" ? turn : undefined;
    },
    whisper: (id, side, text) => post(API.arenaWhisper(id), { side, text }),
    review: (id, draftIndex, approve, confirmWarnings) => post(API.arenaReview(id), { draftIndex, approve, ...(confirmWarnings ? { confirmWarnings: true } : {}) }),
    postAnnotation: (a) => post(API.annotations, a),
    deleteAnnotation: async (id) => {
      await post(`${API.annotations}/${encodeURIComponent(id)}/delete`);
    },
    postCorrection: (c) => post(API.corrections, c),
    listCorrections: async () => unwrap<Correction[]>(await get(API.corrections), "corrections") ?? [],
    reviewCorrection: (id, approve, reviewer) => post<Correction>(API.correctionReview(id), { approve, reviewer }),
    getPlaybook: async () => unwrap<PlaybookEntry[]>(await get(API.playbook), "entries") ?? [],
    getEval: async () => {
      try {
        return await get<EvalReport>(API.evalLatest);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return undefined;
        throw e;
      }
    },
    getEvalRuns: async () => unwrap<EvalRun[]>(await get(API.evalRuns), "runs") ?? [],
    // not in the shared API table: reviewer-only, offline (rules engine) unless {live: true}
    runEval: async () => {
      await post("/eval/run", { live: false });
    },
    upload: async (u, opts) => {
      try {
        return await post<ScriptAnalysis>(opts?.ephemeral ? API.scriptAnalyzeEphemeral : API.scriptUpload, u);
      } finally {
        noteLlmUse(); // analysis may have called the model (even when it then failed)
      }
    },
    saveScript: async (id, draft, analysis) =>
      unwrap<ScamScriptDef>(await post(API.scriptSave(id), analysis?.ephemeral ? { draft, analysis } : { draft }), "script"),
    reviewUploadDraft: (id, draftIndex, approve, confirmWarnings) =>
      post(API.scriptReview(id), { draftIndex, approve, ...(confirmWarnings ? { confirmWarnings: true } : {}) }),
  };
}

/** Probe whether the backend already serves the Arena API (B1 may not be done yet). */
export async function hasArenaApi(apiBase: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const res = await fetchFn(apiBase + API.arenaScripts, { credentials: "include", headers: { Accept: "application/json" } });
    // 401/403: the Arena API exists but wants a login (BAITNET_AUTH=on). Use it — falling back to the in-browser
    // mock here would leave a logged-in user on fake data, since the backend choice is made once.
    if (res.status === 401 || res.status === 403) return true;
    if (!res.ok) return false;
    JSON.parse(await res.text());
    return true;
  } catch {
    return false;
  }
}
