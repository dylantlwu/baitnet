import { useEffect, useRef, useState } from "react";
import type { Me } from "@baitnet/shared";
import { useAuth } from "../auth/context";
import { useBackend } from "../backend/context";
import type { Backend } from "../backend/types";
import { AuthError } from "../auth/api";
import { PageHead } from "../components/ui";
import { useI18n } from "../i18n";
import { href } from "../lib/router";

export interface PendingWork {
  /** rewrites waiting for a reviewer */
  corrections: number;
  /** extracted addresses (arena drafts) waiting for a reviewer */
  addresses: number;
}

/**
 * Where to go after login. Experts practise → arena. Reviewers go where work is waiting: pending rewrites →
 * training review queue, else pending addresses → sessions (the drafts live there), else the arena.
 */
export function landingFor(me: Pick<Me, "role">, pending?: PendingWork | null): string {
  if (me.role !== "reviewer" || !pending) return href("arena");
  if (pending.corrections > 0) return href("training", "review");
  if (pending.addresses > 0) return href("sessions");
  return href("arena");
}

/** Count what waits for a reviewer (best effort, capped at `timeoutMs`: login never hangs on it). */
export async function pendingWork(backend: Pick<Backend, "listCorrections" | "listRecordedSessions"> | null, timeoutMs = 3000): Promise<PendingWork | null> {
  if (!backend) return null;
  const work = Promise.all([backend.listCorrections().catch(() => []), backend.listRecordedSessions().catch(() => [])]).then(([cs, ss]) => ({
    corrections: (Array.isArray(cs) ? cs : []).filter((c) => c?.review === "pending").length,
    addresses: (Array.isArray(ss) ? ss : []).reduce((n, s) => n + (s?.drafts ?? []).filter((d) => d && d.review === "pending" && !d.filteredReason).length, 0),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** landingFor + the pending counts a reviewer needs. */
export async function afterLogin(me: Me, backend: Pick<Backend, "listCorrections" | "listRecordedSessions"> | null): Promise<string> {
  return landingFor(me, me.role === "reviewer" ? await pendingWork(backend) : null);
}

export function LoginPage({ code: codeFromLink, backendDown }: { code?: string | null; backendDown?: boolean }) {
  const { t } = useI18n();
  const { state, admin, setMe, logout } = useAuth();
  const backend = useBackend();
  const [cont, setCont] = useState<string>(href("arena"));
  const [code, setCode] = useState(codeFromLink ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tried = useRef(false);

  const submit = async (c: string) => {
    if (!admin || !c.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const me = await admin.login(c);
      setMe(me);
      // Drop the code from the URL so it is not left in history / screenshots.
      window.location.replace(await afterLogin(me, backend));
    } catch (e) {
      setErr(e instanceof AuthError && (e.status === 401 || e.status === 403) ? t("auth.badCode") : t("common.actionFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  // #/login?code=xxx: one tap from the invite link / QR code.
  useEffect(() => {
    if (codeFromLink && state?.kind === "anonymous" && !tried.current) {
      tried.current = true;
      void submit(codeFromLink);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeFromLink, state?.kind]);

  // already logged in: "continue" goes to the same place a fresh login would
  const me = state?.kind === "user" ? state.me : null;
  useEffect(() => {
    if (!me) return;
    let alive = true;
    void afterLogin(me, backend).then((h) => alive && setCont(h));
    return () => {
      alive = false;
    };
  }, [me, backend]);

  const head = <PageHead step={t("auth.step")} title={t("auth.title")} lead={t("auth.lead")} />;
  if (!state)
    return (
      <>
        {head}
        <div className="loading">
          <span className="spinner" /> {t("common.loading")}
        </div>
      </>
    );
  // Snapshot mode because the probe failed: that is not "local mode without login", say what really happened.
  if (state.kind === "disabled" && backendDown)
    return (
      <>
        {head}
        <div className="card narrow">
          <p>{t("auth.offline")}</p>
        </div>
      </>
    );
  if (state.kind === "disabled")
    return (
      <>
        {head}
        <div className="card narrow">
          <p>{t("auth.disabled")}</p>
          <a className="btn primary" href={href("training", "review")}>
            {t("auth.goReview")}
          </a>
        </div>
      </>
    );
  if (state.kind === "user")
    return (
      <>
        {head}
        <div className="card narrow login-card">
          <p>{t("auth.loggedInAs", { name: state.me.name, role: t(`role.${state.me.role}`) })}</p>
          <div className="row gap">
            <a className="btn primary" href={cont}>
              {t("auth.continue")}
            </a>
            <button type="button" className="btn" onClick={() => void logout()}>
              {t("auth.logout")}
            </button>
          </div>
        </div>
      </>
    );
  return (
    <>
      {head}
      <form
        className="card narrow login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <label className="field">
          <span>{t("auth.code")}</span>
          <input
            className="input big"
            value={code}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={t("auth.codePlaceholder")}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {err && <p className="err">{err}</p>}
        <button type="submit" className="btn primary wide" disabled={busy || !code.trim()}>
          {busy ? t("common.working") : t("auth.login")}
        </button>
        <p className="muted small">{t("auth.hint")}</p>
      </form>
    </>
  );
}
