import { useEffect, useRef, useState } from "react";
import type { Role } from "@baitnet/shared";
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
import { GuidePage } from "./pages/GuidePage";
import { TourProvider, useTour } from "./tour/Tour";
import { useBackend } from "./backend/context";

const TABS = ["arena", "replay", "alerts", "guard", "flows", "responders", "tee", "training", "eval"] as const;
/** Back-office pages (not part of the numbered demo walk-through). */
const ADMIN_TABS = ["sessions", "guide", "team", "login"] as const;
type TabId = (typeof TABS)[number] | (typeof ADMIN_TABS)[number];

/** Phone width (same breakpoint as the stylesheet's phone layout). */
export const NARROW_MQ = "(max-width: 640px)";

/**
 * Logged-in experts / reviewers on a phone see the pages they work in first; the judge demo pages go under
 * "More". Desktop, logged out and auth-off keep the full numbered walk-through (null = full nav).
 */
export function compactNav(role: Role | null, narrow: boolean): { primary: TabId[]; more: TabId[] } | null {
  if (!role || !narrow) return null;
  const primary: TabId[] = role === "reviewer" ? ["arena", "training", "sessions", "eval", "team", "alerts"] : ["arena", "training", "sessions", "eval"];
  return { primary, more: ["guide", ...TABS.filter((id) => !primary.includes(id))] };
}

function useMediaQuery(q: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [q]);
  return m;
}

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
    <TourProvider live={data.mode === "live"}>
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

        <NavTabs tab={tab} />

        <main className="main">
          {data.status === "loading" && !data.snapshot && tab !== "guide" && (
            <div className="loading">
              <span className="spinner" /> {t("app.connecting")}
            </div>
          )}
          {tab === "guide" && <GuidePage />}
          {data.status === "error" && tab !== "guide" && (
            <div className="card error-card">
              <h2>{t("app.noData")}</h2>
              <p className="muted">{data.error}</p>
              <p className="small">{t("app.noDataHint")}</p>
              <button type="button" className="btn primary" onClick={data.retry}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {data.snapshot && tab !== "guide" && (
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
    </TourProvider>
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

export function NavTabs({ tab }: { tab: TabId }) {
  const { t } = useI18n();
  const { state } = useAuth();
  const narrow = useMediaQuery(NARROW_MQ);
  const layout = compactNav(state?.kind === "user" ? state.me.role : null, narrow);
  if (!layout)
    return (
      <nav className="tabs" aria-label={t("nav.label")}>
        {TABS.map((id) => (
          <TabLink key={id} id={id} tab={tab} />
        ))}
        <AdminTabs tab={tab} />
      </nav>
    );
  const inMore = layout.more.includes(tab);
  return (
    <nav className="tabs compact" aria-label={t("nav.label")}>
      {layout.primary.map((id) => (
        <TabLink key={id} id={id} tab={tab} />
      ))}
      <details className="tabs-more" open={inMore || undefined}>
        <summary className={inMore ? "tab more on" : "tab more"}>
          <span className="tab-n">…</span>
          {t("nav.more")}
        </summary>
        <div className="tabs-more-list">
          {layout.more.map((id) => (
            <TabLink key={id} id={id} tab={tab} />
          ))}
        </div>
      </details>
    </nav>
  );
}

function TabLink({ id, tab }: { id: TabId; tab: TabId }) {
  const { t } = useI18n();
  const i = (TABS as readonly string[]).indexOf(id);
  const admin = i < 0;
  return (
    <a href={href(id)} className={`tab${admin ? " admin" : ""}${id === tab ? " on" : ""}`} aria-current={id === tab ? "page" : undefined}>
      <span className="tab-n">{admin ? (id === "team" ? "◆" : id === "guide" ? "?" : "≡") : i}</span>
      {t(`nav.${id}` as MsgKey)}
    </a>
  );
}

function AdminTabs({ tab }: { tab: TabId }) {
  const { state } = useAuth();
  const showTeam = state?.kind === "user" && state.me.role === "reviewer";
  const items: TabId[] = showTeam ? ["sessions", "guide", "team"] : ["sessions", "guide"];
  return (
    <>
      {items.map((id) => (
        <TabLink key={id} id={id} tab={tab} />
      ))}
    </>
  );
}

/** Login state: only rendered when the backend has auth enabled. */
export function UserChip() {
  const { t } = useI18n();
  const { state, logout } = useAuth();
  const tour = useTour();
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => ref.current?.removeAttribute("open");
  if (!state || state.kind === "disabled") return null;
  if (state.kind === "anonymous")
    return (
      <a className="btn small" href={href("login")}>
        {t("auth.login")}
      </a>
    );
  const q = state.me.llmQuota;
  return (
    <details className="user-chip" ref={ref}>
      <summary data-tour="user-chip">
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
        <div className="user-pop-links">
          <a className="btn small" href={href("guide")} onClick={close}>
            ? {t("guide.menu")}
          </a>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              close();
              tour.start();
            }}
          >
            ▶ {t("guide.replay")}
          </button>
        </div>
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

/**
 * Sample sections only reach the screen through the snapshot-seeded backend (read-only replay or the in-browser
 * mock). With the live HTTP backend every arena / training / eval page reads the server, so nothing shown
 * is sample data and the notice would be wrong.
 */
export function visibleSampleSections(sampleSections: string[] | undefined, backendKind: "http" | "mock" | "replay" | null | undefined): string[] | null {
  if (!sampleSections?.length) return null;
  if (backendKind === "http") return null;
  return sampleSections;
}

function ModeBadge({ data }: { data: ReturnType<typeof useData> }) {
  const { t, tl, lang } = useI18n();
  const backend = useBackend();
  // until the backend is chosen we don't know yet: say nothing rather than something wrong
  const sampleShown = backend ? visibleSampleSections(data.sampleSections, backend.kind) : null;
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
        {sampleShown && (
          <div className="muted small">{t("mode.sampleSections", { list: sampleShown.map((k) => tl("section", k)).join(lang === "zh" ? "、" : ", ") })}</div>
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
