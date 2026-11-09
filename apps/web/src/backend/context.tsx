import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ViewSnapshot } from "../data/parse";
import type { Mode } from "../data/source";
import { createHttpBackend, hasArenaApi } from "./http";
import { createMockBackend } from "./mock";
import type { Backend } from "./types";
import { seedFromSnapshot } from "./seed";

const Ctx = createContext<Backend | null>(null);

/**
 * snapshot mode           -> read-only replay backend
 * ?backend=mock           -> writable in-browser mock
 * live + Arena API ready  -> http
 * live, Arena API missing -> mock (backend B1/B2 not deployed yet)
 */
export function BackendProvider({
  mode, apiBase, snapshot, children,
}: { mode?: Mode; apiBase: string | null; snapshot?: ViewSnapshot; children: ReactNode }) {
  const [backend, setBackend] = useState<Backend | null>(null);
  useEffect(() => {
    if (!mode || !snapshot) return;
    const force = new URLSearchParams(window.location.search).get("backend");
    const seed = seedFromSnapshot(snapshot);
    if (force === "mock") return setBackend(createMockBackend(seed));
    if (mode === "snapshot" || apiBase === null) return setBackend(createMockBackend(seed, { readOnly: true }));
    let alive = true;
    hasArenaApi(apiBase).then((ok) => {
      if (alive) setBackend(ok ? createHttpBackend(apiBase) : createMockBackend(seed));
    });
    return () => {
      alive = false;
    };
    // Snapshot identity changes on every poll; only the first one seeds the mock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, apiBase, !!snapshot]);
  return <Ctx.Provider value={backend}>{children}</Ctx.Provider>;
}

export const useBackend = () => useContext(Ctx);
