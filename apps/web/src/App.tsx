import { useEffect, useRef } from "react";
import { useData } from "./data/useData";
import { href, useHashRoute } from "./lib/router";
import { fmtTime } from "./lib/format";
import { I18nProvider, useI18n, type MsgKey } from "./i18n";
import { BackendProvider } from "./backend/context";
import { ArenaPage } from "./pages/ArenaPage";
import { ReplayPage } from "./pages/ReplayPage";
import { AlertsPage } from "./pages/AlertsPage";
import { GuardPage } from "./pages/GuardPage";
import { FlowsPage } from "./pages/FlowsPage";
import { RespondersPage } from "./pages/RespondersPage";
import { TeePage } from "./pages/TeePage";
import { TrainingPage } from "./pages/TrainingPage";
import { EvalPage } from "./pages/EvalPage";
import { SessionsPage } from "./pages/SessionsPage";
import { LoginPage } from "./pages/LoginPage";
import { TeamPage } from "./pages/TeamPage";
import { AuthProvider, useAuth } from "./auth/context";

const TABS = ["arena", "replay", "alerts", "guard", "flows", "responders", "tee", "training", "eval"] as const;
/** Back-office pages (not part of the numbered demo walk-through). */
const ADMIN_TABS = ["sessions", "team", "login"] as const;
type TabId = (typeof TABS)[number] | (typeof ADMIN_TABS)[number];

export default function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}

function Shell() {
  const { t } = useI18n();
  const data = useData();
  const { parts, query } = useHashRoute();
  const tab: TabId = ([...TABS, ...ADMIN_TABS] as readonly string[]).includes(parts[0] ?? "") ? (parts[0] as TabId) : "arena";
  const num = (s?: string | null) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
  const idx = (TABS as readonly string[]).indexOf(tab);
  const next = TABS[idx + 1];
  const apiBase = data.mode === "live" ? data.config.apiBase : null;

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <AuthProvider apiBase={apiBase} ready={!!data.mode}>
    <ReloadOnAuthChange retry={data.retry} />
    <BackendProvider mode={data.mode} apiBase={apiBase} snapshot={data.snapshot}>
      <div className="app">
        <header className="topbar">
          <a className="brand" href={href("arena")}>
            <Logo />
            <span>
              <strong>BaitNet</strong>
              <span className="brand-sub">{t("app.tagline")}</span>
            </span>
          </a>
          <div className="topbar-right">
            {data.snapshot && (
              <div className="net">
                <span className="net-dot" />
                NEAR {t(`network.${data.snapshot.network}`)}
                {data.snapshot.registryContract && <code className="mono">{data.snapshot.registryContract}</code>}
              </div>
            )}
            <UserChip />
            <LangSwitch />
          </div>
        </header>

        <nav className="tabs" aria-label={t("nav.label")}>
          {TABS.map((id, i) => (
            <a key={id} href={href(id)} className={id === tab ? "tab on" : "tab"} aria-current={id === tab ? "page" : undefined}>
              <span className="tab-n">{i}</span>
              {t(`nav.${id}` as MsgKey)}
            </a>
          ))}
          <AdminTabs tab={tab} />
        </nav>

        <main className="main">
          {data.status === "loading" && !data.snapshot && (
            <div className="loading">
              <span className="spinner" /> {t("app.connecting")}
            </div>
          )}
          {data.status === "error" && (
            <div className="card error-card">
              <h2>{t("app.noData")}</h2>
              <p className="muted">{data.error}</p>
              <p className="small">{t("app.noDataHint")}</p>
              <button type="button" className="btn primary" onClick={data.retry}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {data.snapshot && (
            <>
              {tab === "arena" && <ArenaPage snap={data.snapshot} network={data.snapshot.network} />}
              {tab === "replay" && <ReplayPage snap={data.snapshot} convId={parts[1]} />}
              {tab === "alerts" && <AlertsPage snap={data.snapshot} alertId={num(parts[1])} apiBase={apiBase} />}
              {tab === "guard" && (
                <GuardPage snap={data.snapshot} freshIds={data.freshIds} alertFilter={num(query.get("alert"))} live={data.mode === "live"} />
              )}
              {tab === "flows" && <FlowsPage snap={data.snapshot} alertId={num(parts[1])} />}
              {tab === "responders" && <RespondersPage snap={data.snapshot} />}
              {tab === "tee" && <TeePage snap={data.snapshot} apiBase={apiBase} />}
              {tab === "training" && <TrainingPage sub={parts[1]} snap={data.snapshot} />}
              {tab === "eval" && <EvalPage />}
              {tab === "sessions" && <SessionsPage id={parts[1]} snap={data.snapshot} />}
              {tab === "team" && <TeamPage />}
              {tab === "login" && <LoginPage code={query.get("code")} backendDown={data.mode === "snapshot" && data.config.apiBase !== null} />}
              {next && idx >= 0 && (
                <a className="next-step" href={href(next)}>
                  {t("app.next", { n: idx + 1, label: t(`nav.${next}` as MsgKey) })} →
                </a>
              )}
            </>
          )}
        </main>

        <footer className="footer muted small">
          {t("app.footer")}
          {data.snapshot && <> · {t("app.dataAsOf", { at: fmtTime(data.snapshot.generatedAt) })}</>}
        </footer>

        <ModeBadge data={data} />
      </div>
    </BackendProvider>
    </AuthProvider>
  );
}

/**
 * Logged out, the live view only holds the public endpoints (GET /snapshot is reviewer/expert-only with
 * BAITNET_AUTH=on); after login reload to get the full snapshot, after logout reload to drop it again.
 * Only real transitions count (anonymous <-> user), not the first answer from /auth/me.
 */
function ReloadOnAuthChange({ retry }: { retry: () => void }) {
  const { state } = useAuth();
  const key = state?.kind === "user" ? `user:${state.me.expertId}` : state?.kind ?? null;
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (key === null || key === "disabled") return;
    if (prev.current !== null && prev.current !== key) retry();
    prev.current = key;
  }, [key, retry]);
  return null;
}

function AdminTabs({ tab }: { tab: TabId }) {
  const { t } = useI18n();
  const { state } = useAuth();
  const showTeam = state?.kind === "user" && state.me.role === "reviewer";
  const items: TabId[] = showTeam ? ["sessions", "team"] : ["sessions"];
  return (
    <>
      {items.map((id) => (
        <a key={id} href={href(id)} className={id === tab ? "tab admin on" : "tab admin"} aria-current={id === tab ? "page" : undefined}>
          <span className="tab-n">{id === "team" ? "◆" : "≡"}</span>
          {t(`nav.${id}` as MsgKey)}
        </a>
      ))}
    </>
  );
}

/** Login state: only rendered when the backend has auth enabled. */
function UserChip() {
  const { t } = useI18n();
  const { state, logout } = useAuth();
  if (!state || state.kind === "disabled") return null;
  if (state.kind === "anonymous")
    return (
      <a className="btn small" href={href("login")}>
        {t("auth.login")}
      </a>
    );
  const q = state.me.llmQuota;
  return (
    <details className="user-chip">
      <summary>
        <span className="avatar sm">{state.me.name.slice(0, 1)}</span>
        <span className="user-name">{state.me.name}</span>
        {q && (
          <span className={`quota${q.usedToday >= q.limitPerDay ? " out" : ""}`} title={t("auth.quotaTitle")}>
            {q.usedToday}/{q.limitPerDay}
          </span>
        )}
      </summary>
      <div className="mode-pop user-pop">
        <div>
          <b>{state.me.name}</b> · {t(`role.${state.me.role}`)}
        </div>
        {q && <div className="small">{t("auth.quota", { used: q.usedToday, limit: q.limitPerDay })}</div>}
        <button type="button" className="btn small" onClick={() => void logout()}>
          {t("auth.logout")}
        </button>
      </div>
    </details>
  );
}

function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="segmented sm lang-switch" role="radiogroup" aria-label={t("app.language")}>
      <button type="button" role="radio" aria-checked={lang === "zh"} className={lang === "zh" ? "on" : ""} onClick={() => setLang("zh")}>
        中文
      </button>
      <button type="button" role="radio" aria-checked={lang === "en"} className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
        EN
      </button>
    </div>
  );
}

function ModeBadge({ data }: { data: ReturnType<typeof useData> }) {
  const { t, tl, lang } = useI18n();
  if (!data.mode) return null;
  const live = data.mode === "live";
  const sample = !live && (data.source ?? "").includes("sample");
  const label = live ? t("mode.badge.live") : sample ? t("mode.badge.sample") : t("mode.badge.snapshot");
  const reason = data.fallbackReason;
  return (
    <details className={`mode-badge ${live ? "live" : "snap"}`}>
      <summary>
        <span className={live && data.stream === "open" ? "pulse" : "mode-dot"} />
        {label}
      </summary>
      <div className="mode-pop">
        <div>
          <b>{t("mode.mode")}</b> {live ? t("mode.liveBackend") : t("mode.staticSnapshot")}
        </div>
        <div>
          <b>{t("mode.source")}</b> <code className="mono break">{data.source}</code>
        </div>
        {live && (
          <div>
            <b>{t("mode.stream")}</b> {t(`stream.${data.stream}`)}
          </div>
        )}
        {data.snapshot && (
          <div>
            <b>{t("mode.generated")}</b> {fmtTime(data.snapshot.generatedAt)}
          </div>
        )}
        {data.sampleSections && (
          <div className="muted small">{t("mode.sampleSections", { list: data.sampleSections.map((k) => tl("section", k)).join(lang === "zh" ? "、" : ", ") })}</div>
        )}
        {live && data.authRequired && <div className="muted small">{t("mode.authRequired")}</div>}
        {reason && (
          <div className="muted small">
            {reason.kind === "unreachable"
              ? t("mode.reason.unreachable", { msg: reason.detail ?? "" })
              : reason.kind === "timeout"
                ? t("mode.reason.timeout", { sec: Math.round(data.config.liveTimeoutMs / 1000) })
                : t(`mode.reason.${reason.kind}`)}
          </div>
        )}
        {!live && data.config.apiBase !== null && (
          <button type="button" className="btn small" onClick={data.retry}>
            {t("mode.retryLive")}
          </button>
        )}
      </div>
    </details>
  );
}

const Logo = () => (
  <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden className="logo">
    <rect width="32" height="32" rx="8" className="logo-bg" />
    <path d="M16 5l9 4v6c0 6-4 10.5-9 12-5-1.5-9-6-9-12V9z" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinejoin="round" />
    <path d="M12 16l3 3 5-6" fill="none" stroke="var(--logo-fg)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
