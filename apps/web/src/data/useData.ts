import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "@baitnet/shared";
import type { ViewSnapshot } from "./parse";
import { loadInitial, loadLive, mergeEvent, parseSseData, resolveConfig, type DataConfig, type LoadResult, type Mode } from "./source";

export type StreamState = "idle" | "connecting" | "open" | "reconnecting";

export interface DataState {
  status: "loading" | "ready" | "error";
  mode?: Mode;
  snapshot?: ViewSnapshot;
  source?: string;
  fallbackReason?: LoadResult["fallbackReason"];
  sampleSections?: string[];
  error?: string;
  stream: StreamState;
  /** Ids of events that arrived over SSE in this session (for highlight). */
  freshIds: Set<string>;
  config: DataConfig;
}

const POLL_MS = 10_000;

export function useData(): DataState & { retry: () => void } {
  const [config] = useState(() =>
    resolveConfig(window.location, { VITE_API_BASE: import.meta.env.VITE_API_BASE, BASE_URL: import.meta.env.BASE_URL }),
  );
  const [state, setState] = useState<DataState>({ status: "loading", stream: "idle", freshIds: new Set(), config });
  const [attempt, setAttempt] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    setState((s) => ({ ...s, status: "loading" }));

    loadInitial(config)
      .then((r) => {
        if (cancelled) return;
        setState((s) => ({ ...s, status: "ready", ...r, error: undefined }));
        if (r.mode !== "live" || config.apiBase === null) return;
        const api = config.apiBase;

        // SSE: GuardEvent stream.
        if (typeof EventSource !== "undefined") {
          const es = new EventSource(api + API.events, { withCredentials: true });
          esRef.current = es;
          setState((s) => ({ ...s, stream: "connecting" }));
          const onData = (e: MessageEvent<string>) => {
            const ev = parseSseData(e.data);
            if (!ev) return;
            setState((s) =>
              s.snapshot ? { ...s, snapshot: mergeEvent(s.snapshot, ev), freshIds: new Set(s.freshIds).add(ev.id) } : s,
            );
          };
          es.onopen = () => setState((s) => ({ ...s, stream: "open" }));
          es.onerror = () => setState((s) => ({ ...s, stream: "reconnecting" }));
          es.onmessage = onData;
          es.addEventListener("guard", onData as EventListener);
          es.addEventListener("guard-event", onData as EventListener);
        }

        // Periodic refresh for alerts / acks / flows (no push channel for those yet).
        // Skipped while the tab is hidden: every open dashboard costs the server NEAR RPC reads.
        poll = setInterval(() => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          loadLive(fetch, api, 4000)
            .then((snap) =>
              setState((s) => {
                if (!s.snapshot) return s;
                // Keep streamed events that the poll result may not include yet.
                const prev = s.snapshot;
                let merged: ViewSnapshot = {
                  ...snap,
                  conversations: snap.conversations.length ? snap.conversations : prev.conversations,
                  arenaScripts: snap.arenaScripts?.length ? snap.arenaScripts : prev.arenaScripts,
                  arenaSessions: snap.arenaSessions?.length ? snap.arenaSessions : prev.arenaSessions,
                  eval: snap.eval ?? prev.eval,
                  evalRuns: snap.evalRuns?.length ? snap.evalRuns : prev.evalRuns,
                  playbook: snap.playbook?.length ? snap.playbook : prev.playbook,
                  corrections: snap.corrections?.length ? snap.corrections : prev.corrections,
                };
                for (const ev of s.snapshot.events) if (!merged.events.some((e) => e.id === ev.id)) merged = mergeEvent(merged, ev);
                return { ...s, snapshot: merged };
              }),
            )
            .catch(() => undefined);
        }, POLL_MS);
      })
      .catch((e: Error) => {
        if (!cancelled) setState((s) => ({ ...s, status: "error", error: e.message }));
      });

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [config, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
