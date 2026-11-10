import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { ArenaSession, ChannelKind, Correction, ScamScriptDef, User } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { useBackend } from "../backend/context";
import type { Backend } from "../backend/types";
import { useAuth } from "../auth/context";
import { arenaReducer, initialArena } from "../arena/reducer";
import { ChannelIcon } from "../components/Channel";
import { Badge, Empty, PageHead, Segmented, LoadFailed } from "../components/ui";
import { useI18n } from "../i18n";
import { fmtTime } from "../lib/format";
import { href } from "../lib/router";
import { normalizeScripts } from "../backend/normalize";
import { DraftItem, EngineBadge, TurnRow, useExpert } from "./ArenaPage";
import { CorrectionCard } from "./TrainingPage";

type ChannelFilter = "all" | ChannelKind;

export const channelOf = (s: ArenaSession): ChannelKind => s.channel?.kind ?? "web";

/** Who plays which side: explicit expertPlays (IM) or inferred from the web side modes. */
export function playsOf(s: ArenaSession): "scammer" | "bait" | "observer" {
  if (s.channel?.expertPlays) return s.channel.expertPlays;
  if (s.modes.scammer === "human") return "scammer";
  if (s.modes.bait === "human") return "bait";
  return "observer";
}

export function SessionsPage({ id, snap }: { id?: string; snap: ViewSnapshot }) {
  const { t } = useI18n();
  const backend = useBackend();
  const head = <PageHead step={t("sessions.step")} title={t("sessions.title")} lead={t("sessions.lead")} />;
  if (!backend)
    return (
      <>
        {head}
        <div className="loading">
          <span className="spinner" /> {t("common.loading")}
        </div>
      </>
    );
  return (
    <>
      {head}
      {backend.readOnly && <p className="note info-note">{t("sessions.hostedHint")}</p>}
      {id ? <SessionDetail key={id} id={id} backend={backend} snap={snap} /> : <SessionList backend={backend} />}
    </>
  );
}

function useNames() {
  const { state, admin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    if (state?.kind === "user" && state.me.role === "reviewer" && admin) admin.listUsers().then(setUsers, () => undefined);
  }, [state, admin]);
  return useCallback(
    (ownerId?: string) => {
      if (!ownerId) return "—";
      if (ownerId === "local-expert") return null;
      if (state?.kind === "user" && state.me.expertId === ownerId) return state.me.name;
      return users.find((u) => u.id === ownerId)?.name ?? ownerId;
    },
    [users, state],
  );
}

function SessionList({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ArenaSession[] | null>(null);
  const [scripts, setScripts] = useState<Map<string, ScamScriptDef>>(new Map());
  const [corr, setCorr] = useState<Correction[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ch, setCh] = useState<ChannelFilter>("all");
  const [onlyTodo, setOnlyTodo] = useState(false);
  const nameOf = useNames();

  useEffect(() => {
    backend.listRecordedSessions().then((s) => setSessions(Array.isArray(s) ? s : []), (e: Error) => setErr(e.message));
    backend.listScripts().then((s) => setScripts(new Map(normalizeScripts(s).map((x) => [x.id, x]))), () => undefined);
    backend.listCorrections().then((c) => setCorr(Array.isArray(c) ? c : []), () => undefined);
  }, [backend]);

  if (err) return <LoadFailed msg={err} />;
  if (!sessions)
    return (
      <div className="loading">
        <span className="spinner" /> {t("common.loading")}
      </div>
    );
  const pendingDrafts = (s: ArenaSession) => s.drafts.filter((d) => d && d.review === "pending" && !d.filteredReason).length;
  const pendingCorr = (s: ArenaSession) => corr.filter((c) => c.sessionId === s.id && c.review === "pending").length;
  const count = (k: ChannelKind) => sessions.filter((s) => channelOf(s) === k).length;
  const list = sessions
    .filter((s) => (ch === "all" || channelOf(s) === ch) && (!onlyTodo || pendingDrafts(s) + pendingCorr(s) > 0))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <>
      <div className="toolbar">
        <Segmented
          label={t("sessions.channel")}
          value={ch}
          onChange={setCh}
          options={[
            { value: "all", label: `${t("common.all")} ${sessions.length}` },
            { value: "telegram", label: `Telegram ${count("telegram")}` },
            { value: "lark", label: `${t("channel.lark")} ${count("lark")}` },
            { value: "web", label: `${t("channel.web")} ${count("web")}` },
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} />
          {t("sessions.onlyTodo")}
        </label>
      </div>
      {list.length === 0 ? (
        <Empty>{t("sessions.empty")}</Empty>
      ) : (
        <ul className="session-list">
          {list.map((s) => {
            const sc = scripts.get(s.scriptId);
            const pd = pendingDrafts(s);
            const pc = pendingCorr(s);
            const owner = nameOf(s.channel?.ownerId);
            return (
              <li key={s.id}>
                <a className="card session-row" href={href("sessions", s.id)}>
                  <div className="row gap">
                    <ChannelIcon kind={channelOf(s)} withLabel />
                    <Badge tone={s.status === "running" ? "ok" : s.status === "paused" ? "info" : "muted"}>{t(`status.${s.status}`)}</Badge>
                    <EngineBadge session={s} />
                    <span className="muted small push">{fmtTime(s.createdAt)}</span>
                  </div>
                  <strong className="session-title">{sc?.title ?? s.scriptId}</strong>
                  <div className="row gap small">
                    <span>
                      {owner ?? t("sessions.localExpert")} · {t(`plays.${playsOf(s)}`)}
                    </span>
                    <span className="muted">· {t("replay.turns", { n: s.turns.length })}</span>
                  </div>
                  {(pd > 0 || pc > 0) && (
                    <div className="row gap">
                      {pd > 0 && <Badge tone="danger">{t("sessions.pendingDrafts", { n: pd })}</Badge>}
                      {pc > 0 && <Badge tone="warn">{t("sessions.pendingCorrections", { n: pc })}</Badge>}
                    </div>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function SessionDetail({ id, backend, snap }: { id: string; backend: Backend; snap: ViewSnapshot }) {
  const { t } = useI18n();
  const [st, dispatch] = useReducer(arenaReducer, initialArena);
  const [script, setScript] = useState<ScamScriptDef | undefined>();
  const [corr, setCorr] = useState<Correction[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [reviewer] = useExpert();
  const nameOf = useNames();

  const loadCorr = useCallback(() => {
    backend.listCorrections().then((c) => setCorr((Array.isArray(c) ? c : []).filter((x) => x.sessionId === id)), () => undefined);
  }, [backend, id]);

  useEffect(() => {
    let unsub = () => undefined as unknown;
    backend.getSession(id).then(
      (s) => {
        dispatch({ type: "session", session: s });
        // Live sessions (IM or web) keep streaming while the reviewer watches.
        if (s.status !== "finished") unsub = backend.subscribe(id, (event) => dispatch({ type: "event", event }));
        backend.listScripts().then((all) => setScript(normalizeScripts(all).find((x) => x.id === s.scriptId)), () => undefined);
      },
      (e: Error) => setErr(e.message),
    );
    loadCorr();
    return () => {
      unsub();
    };
  }, [backend, id, loadCorr]);

  const s = st.session;
  const review = (i: number, ok: boolean) => {
    setBusy((b) => new Set(b).add(i));
    backend
      .review(id, i, ok)
      .then(() => backend.getSession(id))
      .then(
        (fresh) => {
          // Keep any on-chain result that arrived over SSE first.
          if (fresh.drafts[i]?.review !== "pending") dispatch({ type: "session", session: fresh });
        },
        (e: Error) => setErr(e.message),
      )
      .finally(() => setBusy((b) => {
        const n = new Set(b);
        n.delete(i);
        return n;
      }));
  };
  const drafts = useMemo(() => (s ? s.drafts.map((d, i) => [d, i] as const).filter(([d]) => !!d) : []), [s]);

  if (err) return <LoadFailed msg={err} />;
  if (!s)
    return (
      <div className="loading">
        <span className="spinner" /> {t("common.loading")}
      </div>
    );
  const owner = nameOf(s.channel?.ownerId);
  return (
    <div className="session-detail">
      <a className="back-link" href={href("sessions")}>
        ← {t("sessions.back")}
      </a>
      <div className="card session-meta">
        <div className="row gap">
          <ChannelIcon kind={channelOf(s)} withLabel />
          <Badge tone={s.status === "running" ? "ok" : "muted"}>{t(`status.${s.status}`)}</Badge>
          <EngineBadge session={s} />
          <span className="muted small push">{fmtTime(s.createdAt)}</span>
        </div>
        <h2 className="session-title">{script?.title ?? s.scriptId}</h2>
        <div className="small">
          {owner ?? t("sessions.localExpert")} · {t(`plays.${playsOf(s)}`)} · {t("replay.turns", { n: s.turns.length })}
          {s.rating && <> · {t("sessions.rating", { score: s.rating.score })}</>}
        </div>
        {s.rating?.note && <p className="muted small">“{s.rating.note}”</p>}
      </div>

      <section className="card" aria-label={t("arena.drafts")}>
        <h2>{t("arena.drafts")}</h2>
        {drafts.length === 0 ? (
          <p className="muted small">{t("arena.noDrafts")}</p>
        ) : (
          <ul className="draft-list">
            {drafts.map(([d, i]) => (
              <DraftItem key={i} d={d} i={i} network={snap.network} tx={st.txHashes[i]} readOnly={backend.readOnly} busy={busy.has(i)} onReview={review} />
            ))}
          </ul>
        )}
      </section>

      {corr.length > 0 && (
        <section aria-label={t("training.sub.review")}>
          <h2 className="section-h">{t("sessions.corrections", { n: corr.length })}</h2>
          <ul className="corrections">
            {corr.map((c) => (
              <CorrectionCard key={c.id} c={c} backend={backend} reviewer={reviewer} onDone={loadCorr} />
            ))}
          </ul>
        </section>
      )}

      <section className="card chat-replay" aria-label={t("arena.conversation")}>
        <h2>{t("sessions.transcript")}</h2>
        <div className="chat1">
          {s.turns.length === 0 && <p className="muted small">{t("sessions.noTurns")}</p>}
          {s.turns.map((turn) => (
            <TurnRow key={turn.index} turn={turn} snap={snap} training={false} expert="" session={s} script={script} />
          ))}
        </div>
      </section>
    </div>
  );
}
