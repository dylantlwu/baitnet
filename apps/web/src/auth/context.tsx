import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me, Role } from "@baitnet/shared";
import { createHttpAdmin, createMockAdmin, type AdminApi, type AuthState } from "./api";
import { LLM_USED_EVENT } from "../lib/quota";

interface AuthCtx {
  state: AuthState | null; // null while loading
  admin: AdminApi | null;
  setMe: (me: Me) => void;
  refresh: () => void;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>({ state: { kind: "disabled" }, admin: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined });

/** ?auth=mock | ?auth=mock-reviewer | ?auth=mock-expert : in-browser auth for dev & screenshots. */
export function pickAdmin(apiBase: string | null, search: string): AdminApi | null {
  const q = new URLSearchParams(search).get("auth");
  if (q === "mock" || q === "mock-reviewer" || q === "mock-expert") {
    const as: Role | undefined = q === "mock-reviewer" ? "reviewer" : q === "mock-expert" ? "expert" : undefined;
    return createMockAdmin({ loggedInAs: as });
  }
  return apiBase === null ? null : createHttpAdmin(apiBase);
}

/**
 * After logout every page must forget what it loaded while logged in (session lists, review queues…).
 * Pages keep that in component state, so the simplest complete reset is a reload on the login page.
 */
export function reloadAfterLogout(loc: Pick<Location, "hash" | "reload"> = location): void {
  loc.hash = "#/login";
  loc.reload();
}

/** Quota refresh after LLM work: wait for a burst of calls to settle, then one /auth/me. */
export const QUOTA_REFRESH_DELAY_MS = 1500;

export function AuthProvider({
  apiBase, ready, children, initialState, adminOverride, onLoggedOut = reloadAfterLogout,
}: { apiBase: string | null; ready: boolean; children: ReactNode; initialState?: AuthState; adminOverride?: AdminApi; onLoggedOut?: () => void }) {
  const admin = useMemo(
    () => adminOverride ?? (ready ? pickAdmin(apiBase, typeof location !== "undefined" ? location.search : "") : null),
    [apiBase, ready, adminOverride],
  );
  const [state, setState] = useState<AuthState | null>(initialState ?? null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!ready) return;
    if (!admin) return setState({ kind: "disabled" });
    let alive = true;
    admin.me().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, [admin, ready, n]);
  // Quota chip (used / limit) follows LLM use: the backend announces "LLM work done" (an AI turn on the
  // stream, an analysis returned) and we re-read /auth/me once things are quiet. No polling.
  const loggedIn = state?.kind === "user";
  useEffect(() => {
    if (!loggedIn || !admin || typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const onUse = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        admin.me().then((s) => alive && s.kind === "user" && setState(s), () => undefined);
      }, QUOTA_REFRESH_DELAY_MS);
    };
    window.addEventListener(LLM_USED_EVENT, onUse);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener(LLM_USED_EVENT, onUse);
    };
  }, [loggedIn, admin]);
  const value = useMemo<AuthCtx>(
    () => ({
      state,
      admin,
      setMe: (me) => setState({ kind: "user", me }),
      refresh: () => setN((x) => x + 1),
      logout: async () => {
        await admin?.logout().catch(() => undefined);
        setState({ kind: "anonymous" });
        onLoggedOut();
      },
    }),
    [state, admin, onLoggedOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/**
 * Who is acting, and what they may do.
 * auth off: name comes from localStorage (editable) and everyone may review (today's behaviour).
 * auth on : name = logged-in user (read-only); only reviewers see review / publish buttons.
 */
export function useIdentity(localName: string): { name: string; editable: boolean; canReview: boolean; authOn: boolean; loggedIn: boolean } {
  const { state } = useAuth();
  return useMemo(() => {
    if (state?.kind === "user") return { name: state.me.name, editable: false, canReview: state.me.role === "reviewer", authOn: true, loggedIn: true };
    if (state?.kind === "anonymous") return { name: "", editable: false, canReview: false, authOn: true, loggedIn: false };
    return { name: localName, editable: true, canReview: true, authOn: false, loggedIn: false };
  }, [state, localName]);
}
