/**
 * "Some LLM work just finished" signal for the quota chip (used / limit, top right).
 * The backend client fires it after calls that spend quota (an AI turn arriving on the arena stream,
 * an upload analysis returning); the auth provider listens and re-reads /auth/me once, debounced.
 */
export const LLM_USED_EVENT = "baitnet:llm-used";

export function noteLlmUse(): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(LLM_USED_EVENT));
  } catch {
    /* no window (tests / SSR) */
  }
}
