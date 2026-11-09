import type { ArenaEvent, ArenaSession, ArenaSide } from "@baitnet/shared";

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
}

export type ArenaAction =
  | { type: "reset" }
  | { type: "session"; session: ArenaSession }
  | { type: "event"; event: ArenaEvent }
  | { type: "sayStart"; pending: Omit<PendingTurn, "status" | "error"> }
  | { type: "sayFailed"; localId: string; error: string }
  | { type: "sayRetry"; localId: string }
  | { type: "sayDiscard"; localId: string };

export const initialArena: ArenaState = { session: null, txHashes: {}, safetyLog: [], pending: [] };

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
  }
}

export function applyEvent(state: ArenaState, e: ArenaEvent): ArenaState {
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
      return { ...state, pending, session: { ...s, turns } };
    }
    case "draft": {
      const drafts = [...s.drafts];
      drafts[e.draftIndex] = e.draft;
      return { ...state, session: { ...s, drafts } };
    }
    case "mode":
      return { ...state, session: { ...s, modes: { ...s.modes, [e.side]: e.mode } } };
    case "status":
      return { ...state, session: { ...s, status: e.status } };
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
