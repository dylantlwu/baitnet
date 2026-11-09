import type { ArenaSide } from "@baitnet/shared";
import type { Backend } from "../backend/types";
import type { ArenaAction } from "./reducer";

let seq = 0;
export const newLocalId = () => `local-${Date.now().toString(36)}-${++seq}`;

/**
 * Optimistic "say": show the line immediately as "sending", confirm with the turn the server
 * returns (or the SSE turn event, whichever comes first; the reducer dedupes by index), mark failed on error.
 */
export async function sendSay(
  backend: Pick<Backend, "say">,
  sessionId: string,
  side: ArenaSide,
  text: string,
  dispatch: (a: ArenaAction) => void,
  retryOf?: string,
): Promise<boolean> {
  const localId = retryOf ?? newLocalId();
  dispatch(retryOf ? { type: "sayRetry", localId } : { type: "sayStart", pending: { localId, side, text, ts: new Date().toISOString() } });
  try {
    const turn = await backend.say(sessionId, side, text);
    if (turn) dispatch({ type: "event", event: { type: "turn", sessionId, turn } });
    return true;
  } catch (e) {
    dispatch({ type: "sayFailed", localId, error: (e as Error).message || String(e) });
    return false;
  }
}
