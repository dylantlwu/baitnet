import type { ArenaSession, ArenaSide, ArenaTurn, DecoyMind, DecoyPersona, ScammerMind } from "@baitnet/shared";
import type { ArenaStreamEvent } from "../backend/types";

/** A human line shown immediately (optimistic) until the server's "turn" event replaces it. */
export interface PendingTurn {
  localId: string;
  side: ArenaSide;
  text: string;
  status: "sending" | "failed";
  error?: string;
  ts: string;
}

export interface ArenaState {
  session: ArenaSession | null;
  /** draftIndex -> registry tx hash (ArenaSession.drafts has no txHash field). */
  txHashes: Record<number, string>;
  safetyLog: { side: ArenaSide; rule: string }[];
  pending: PendingTurn[];
  /** Side whose AI line is being generated ("typing…"), null when idle. */
  typing: ArenaSide | null;
}

export type ArenaAction =
  | { type: "reset" }
  | { type: "session"; session: ArenaSession }
  | { type: "event"; event: ArenaStreamEvent }
  | { type: "sayStart"; pending: Omit<PendingTurn, "status" | "error"> }
  | { type: "sayFailed"; localId: string; error: string }
  | { type: "sayRetry"; localId: string }
  | { type: "sayDiscard"; localId: string }
  /** D32: fresh hidden decoy state from a session re-read (absent fields leave the current value alone). */
  | {
      type: "mind";
      sessionId: string;
      persona?: DecoyPersona;
      decoyMind?: DecoyMind;
      /** D34: scammer card / mask and hidden scammer state */
      scammer?: ArenaSession["scammer"];
      scammerMind?: ScammerMind;
      turns?: ArenaTurn[];
    };

export const initialArena: ArenaState = { session: null, txHashes: {}, safetyLog: [], pending: [], typing: null };

const norm = (t: string) => t.trim().replace(/\s+/g, " ");

export function arenaReducer(state: ArenaState, action: ArenaAction): ArenaState {
  switch (action.type) {
    case "reset":
      return initialArena;
    case "session":
      return {
        session: { ...action.session, turns: [...action.session.turns].sort((a, b) => a.index - b.index) },
        txHashes: {},
        safetyLog: [],
        pending: [],
        typing: null,
      };
    case "event":
      return applyEvent(state, action.event);
    case "sayStart":
      return { ...state, pending: [...state.pending, { ...action.pending, status: "sending" }] };
    case "sayFailed":
      return { ...state, pending: state.pending.map((p) => (p.localId === action.localId ? { ...p, status: "failed", error: action.error } : p)) };
    case "sayRetry":
      return { ...state, pending: state.pending.map((p) => (p.localId === action.localId ? { ...p, status: "sending", error: undefined } : p)) };
    case "sayDiscard":
      return { ...state, pending: state.pending.filter((p) => p.localId !== action.localId) };
    case "mind": {
      const s = state.session;
      if (!s || s.id !== action.sessionId) return state;
      // a line's hidden note may only be on the re-read copy: fill it in where the streamed turn has none
      const fresh = (action.turns ?? []).filter((x) => x && typeof x.index === "number");
      const minds = new Map(fresh.filter((x) => x.mind).map((x) => [x.index, x.mind!]));
      const sMinds = new Map(fresh.filter((x) => x.scammerMind).map((x) => [x.index, x.scammerMind!]));
      const turns =
        minds.size || sMinds.size
          ? s.turns.map((x) => {
              let y = x;
              if (!y.mind && minds.has(y.index)) y = { ...y, mind: minds.get(y.index) };
              if (!y.scammerMind && sMinds.has(y.index)) y = { ...y, scammerMind: sMinds.get(y.index) };
              return y;
            })
          : s.turns;
      return {
        ...state,
        session: {
          ...s,
          turns,
          persona: action.persona ?? s.persona,
          decoyMind: action.decoyMind ?? s.decoyMind,
          scammer: action.scammer ?? s.scammer,
          scammerMind: action.scammerMind ?? s.scammerMind,
        },
      };
    }
  }
}

export function applyEvent(state: ArenaState, e: ArenaStreamEvent): ArenaState {
  const s = state.session;
  if (!s || e.sessionId !== s.id) return state;
  switch (e.type) {
    case "turn": {
      const turns = s.turns.filter((t) => t.index !== e.turn.index);
      const isNew = turns.length === s.turns.length;
      turns.push(e.turn);
      turns.sort((a, b) => a.index - b.index);
      // The confirmed human line replaces its optimistic copy (oldest match first).
      let pending = state.pending;
      if (isNew && e.turn.author === "human") {
        const i = pending.findIndex((p) => p.side === e.turn.side && norm(p.text) === norm(e.turn.text));
        if (i >= 0) pending = pending.filter((_, j) => j !== i);
      }
      // the AI line that was being "typed" has arrived (also covers a lost typing-off event)
      const typing = state.typing === e.turn.side && e.turn.author !== "human" ? null : state.typing;
      return { ...state, pending, typing, session: { ...s, turns } };
    }
    case "draft": {
      const drafts = [...s.drafts];
      drafts[e.draftIndex] = e.draft;
      return { ...state, session: { ...s, drafts } };
    }
    case "mode":
      return { ...state, session: { ...s, modes: { ...s.modes, [e.side]: e.mode } } };
    case "status":
      return { ...state, typing: e.status === "finished" ? null : state.typing, session: { ...s, status: e.status } };
    case "typing":
      return { ...state, typing: e.on ? e.side : state.typing === e.side ? null : state.typing };
    case "onchain": {
      const d = s.drafts[e.draftIndex];
      if (!d) return state;
      const drafts = [...s.drafts];
      drafts[e.draftIndex] = { ...d, review: "approved", alertId: e.alertId };
      const txHashes = e.txHash ? { ...state.txHashes, [e.draftIndex]: e.txHash } : state.txHashes;
      return { ...state, txHashes, session: { ...s, drafts } };
    }
    case "safety":
      return { ...state, safetyLog: [...state.safetyLog, { side: e.side, rule: e.rule }] };
    default:
      return state;
  }
}

/** Whose turn is next: strictly alternating, scammer opens. */
export function nextSide(session: ArenaSession): ArenaSide {
  const last = session.turns[session.turns.length - 1];
  return !last || last.side === "bait" ? "scammer" : "bait";
}
