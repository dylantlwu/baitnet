import { useEffect, useRef, useState } from "react";
import type { Me } from "@baitnet/shared";
import { useAuth } from "../auth/context";
import { AuthError } from "../auth/api";
import { PageHead } from "../components/ui";
import { useI18n } from "../i18n";
import { href } from "../lib/router";

/** Where to go after login: reviewers manage the team, experts look at the review queue. */
export const afterLogin = (me: Me) => (me.role === "reviewer" ? href("sessions") : href("training", "review"));

export function LoginPage({ code: codeFromLink, backendDown }: { code?: string | null; backendDown?: boolean }) {
  const { t } = useI18n();
  const { state, admin, setMe, logout } = useAuth();
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
      window.location.replace(afterLogin(me));
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
            <a className="btn primary" href={afterLogin(state.me)}>
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
