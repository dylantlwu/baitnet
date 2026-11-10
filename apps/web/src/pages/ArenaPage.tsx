import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ARENA_MODELS, DEFAULT_ARENA_MODEL, type ArenaModelChoice, type ArenaSession, type ArenaSide, type ArenaTurn, type ScamScriptDef, type ScamType, type SideMode, type TurnRating } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import type { ArenaModelsInfo, Backend } from "../backend/types";
import { useBackend } from "../backend/context";
import { arenaReducer, initialArena, nextSide } from "../arena/reducer";
import { RichText } from "../components/RichText";
import { Badge, ChainTag, Empty, Mono, PageHead, Segmented, LoadFailed, Switch } from "../components/ui";
import { useI18n, type MsgKey } from "../i18n";
import { fmtClock, nearTxUrl, short } from "../lib/format";
import { href } from "../lib/router";
import { EXPERT_KEY, load, save } from "../lib/storage";
import { SCAM_TYPES } from "../scriptlab/analyze";
import { normalizeScripts } from "../backend/normalize";
import { sendSay } from "../arena/optimistic";
import type { PendingTurn } from "../arena/reducer";
import { useIdentity } from "../auth/context";
import { ConfirmDialog } from "../components/ConfirmDialog";

export const TACTIC_TAGS = [
  "stalling", "ask-address", "ask-chain", "confirm-details", "play-dumb",
  "feign-interest", "build-rapport", "resist-injection", "deflect-pii", "verify-url",
];
const MODES: SideMode[] = ["ai", "human", "ai+whisper"];
const SIDES: ArenaSide[] = ["scammer", "bait"];

const isUploaded = (s: ScamScriptDef) => s.source !== "original";

export function ArenaPage({ snap, network }: { snap: ViewSnapshot; network: ViewSnapshot["network"] }) {
  const { t } = useI18n();
  const backend = useBackend();
  const [scripts, setScripts] = useState<ScamScriptDef[] | null>(null);
  const [recorded, setRecorded] = useState<ArenaSession[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [active, setActive] = useState<{ session: ArenaSession; recorded: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!backend) return;
    setErr(null);
    // Recorded sessions are optional: their failure must not hide the script list.
    Promise.allSettled([backend.listScripts(), backend.listRecordedSessions()]).then(([s, r]) => {
      if (s.status === "fulfilled") setScripts(normalizeScripts(s.value));
      else setErr((s.reason as Error)?.message ?? String(s.reason));
      setRecorded(r.status === "fulfilled" && Array.isArray(r.value) ? r.value.filter((x) => x && Array.isArray(x.turns)) : []);
    });
  }, [backend]);

  const lead = t("arena.lead");
  if (!backend || !scripts)
    return (
      <>
        <PageHead step={t("arena.step")} title={t("arena.title")} lead={lead} />
        {err ? <LoadFailed msg={err} /> : <div className="loading"><span className="spinner" /> {t("common.loading")}</div>}
      </>
    );

  const script = scripts.find((s) => s.id === (active?.session.scriptId ?? picked));

  return (
    <>
      <PageHead step={t("arena.step")} title={t("arena.title")} lead={lead}>
        <BackendBadge backend={backend} />
      </PageHead>
      {backend.readOnly && <p className="note info-note">{t("arena.hostedHint")}</p>}
      {backend.kind === "mock" && <p className="note warn-note">{t("arena.mockHint")}</p>}

      {!active ? (
        <ScriptPicker
          scripts={scripts}
          recorded={recorded}
          backend={backend}
          picked={picked}
          onPick={setPicked}
          onStart={(session, rec) => setActive({ session, recorded: rec })}
        />
      ) : (
        <>
          <div className="toolbar session-bar">
            <span className="muted small">{t("arena.script")}</span>
            <strong className="ellipsis">{script?.title ?? active.session.scriptId}</strong>
            {script && <ScriptTags s={script} />}
            <button type="button" className="btn small push" onClick={() => setActive(null)}>
              {t("arena.changeScript")}
            </button>
          </div>
          {active.recorded ? (
            <ReplaySession key={active.session.id} rec={active.session} script={script} snap={snap} network={network} />
          ) : (
            <LiveSession key={active.session.id} initial={active.session} script={script} backend={backend} snap={snap} network={network} />
          )}
        </>
      )}
    </>
  );
}

function BackendBadge({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  const tone = backend.kind === "http" ? "ok" : backend.kind === "mock" ? "warn" : "info";
  return <Badge tone={tone}>{t(`backend.${backend.kind}`)}</Badge>;
}

function ScriptTags({ s }: { s: ScamScriptDef }) {
  const { t, tl } = useI18n();
  return (
    <span className="row gap-s">
      <Badge tone="muted">{tl("type", s.type)}</Badge>
      <Badge tone="muted">{s.lang === "zh" ? t("lang.zh") : t("lang.en")}</Badge>
      {isUploaded(s) && <Badge tone="accent">{t("arena.uploaded")}</Badge>}
      {s.poison && <Badge tone="warn" title={s.poison.why}>{t("arena.poison")}</Badge>}
    </span>
  );
}

/* ───────────── script picker ───────────── */

/** Same breakpoint as the stylesheet: below it the script list and the detail card are stacked. */
const STACKED_MQ = "(max-width: 1080px)";

export function ScriptPicker({
  scripts, recorded, backend, picked, onPick, onStart,
}: {
  scripts: ScamScriptDef[];
  recorded: ArenaSession[];
  backend: Backend;
  picked: string | null;
  onPick: (id: string) => void;
  onStart: (s: ArenaSession, recorded: boolean) => void;
}) {
  const { t, tl } = useI18n();
  // Defensive: whatever the backend sent, render from normalised arrays (empty list / half-filled scripts never crash).
  const safeScripts = useMemo(() => normalizeScripts(scripts), [scripts]);
  const safeRecorded = useMemo(() => (Array.isArray(recorded) ? recorded.filter((r) => r && typeof r.scriptId === "string") : []), [recorded]);
  const [type, setType] = useState<ScamType | "all">("all");
  const [lang, setLang] = useState<"all" | "zh" | "en">("all");
  const [modes, setModes] = useState<Record<ArenaSide, SideMode>>({ scammer: "ai", bait: "ai" });
  const [model, setModel] = useState<ArenaModelChoice>(DEFAULT_ARENA_MODEL);
  const [modelInfo, setModelInfo] = useState<ArenaModelsInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (backend.readOnly || !backend.listModels) return;
    let alive = true;
    backend
      .listModels()
      .then((m) => {
        if (!alive || !m || !Array.isArray(m.models)) return;
        setModelInfo(m);
        setModel((cur) => (cur === DEFAULT_ARENA_MODEL && m.models.some((x) => x.id === m.default) ? m.default : cur));
      })
      .catch(() => undefined); // older server: the static list is shown, server picks its default
    return () => {
      alive = false;
    };
  }, [backend]);
  const [err, setErr] = useState<string | null>(null);

  const recBy = useMemo(() => {
    const m = new Map<string, ArenaSession[]>();
    for (const r of safeRecorded) m.set(r.scriptId, [...(m.get(r.scriptId) ?? []), r]);
    return m;
  }, [safeRecorded]);
  const list = safeScripts.filter(
    (s) => (type === "all" || s.type === type) && (lang === "all" || s.lang === lang) && (!backend.readOnly || recBy.has(s.id)),
  );
  const sel = safeScripts.find((s) => s.id === picked) ?? list[0];
  const detailRef = useRef<HTMLElement>(null);
  // Phones (stacked layout): jump from the tapped card straight to the settings + "start" button.
  const pick = (id: string) => {
    onPick(id);
    if (typeof window === "undefined" || !window.matchMedia?.(STACKED_MQ).matches) return;
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const start = async () => {
    if (!sel) return;
    setErr(null);
    if (backend.readOnly) {
      const r = recBy.get(sel.id)?.[0];
      if (r) onStart(r, true);
      return;
    }
    setBusy(true);
    try {
      onStart(await backend.createSession(sel.id, modes, model), false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picker-grid">
      <section className="card" aria-label={t("arena.scripts")} data-tour="arena-scripts">
        <div className="toolbar">
          <select className="select" value={type} onChange={(e) => setType(e.target.value as ScamType | "all")} aria-label={t("arena.filterType")}>
            <option value="all">{t("arena.allTypes")}</option>
            {SCAM_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {tl("type", ty)}
              </option>
            ))}
          </select>
          <Segmented
            label={t("arena.filterLang")}
            value={lang}
            onChange={setLang}
            options={[
              { value: "all", label: t("common.all") },
              { value: "zh", label: t("lang.zh") },
              { value: "en", label: t("lang.en") },
            ]}
          />
          <span className="muted small push">{t("arena.scriptCount", { n: list.length })}</span>
        </div>
        {list.length === 0 ? (
          <Empty>{backend.readOnly ? t("arena.noRecorded") : t("arena.noScripts")}</Empty>
        ) : (
          <ul className="script-list">
            {list.map((s) => (
              <li key={s.id}>
                <button type="button" className={s.id === sel?.id ? "script-item on" : "script-item"} onClick={() => pick(s.id)}>
                  <span className="script-title">{s.title}</span>
                  <ScriptTags s={s} />
                  {recBy.has(s.id) && <span className="muted small">{t("arena.recordedCount", { n: recBy.get(s.id)!.length })}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sel && (
        <section ref={detailRef} className="card script-detail" aria-label={sel.title}>
          <h2>{sel.title}</h2>
          <ScriptTags s={sel} />
          <dl className="kv">
            <dt>{t("arena.persona")}</dt>
            <dd>{sel.persona || "—"}</dd>
            <dt>{t("arena.goal")}</dt>
            <dd>{sel.goal || "—"}</dd>
            <dt>{t("arena.stages")}</dt>
            <dd>{sel.stages.map((s) => s.name).join(" → ") || "—"}</dd>
            <dt>{t("arena.injections")}</dt>
            <dd>{t("arena.injectionCount", { n: sel.injections.length })}</dd>
            {isUploaded(sel) && typeof sel.source === "object" && (
              <>
                <dt>{t("arena.source")}</dt>
                <dd className="small">{sel.source.citation}</dd>
              </>
            )}
          </dl>
          {!backend.readOnly && (
            <div className="start-modes" data-tour="arena-modes">
              {SIDES.map((side) => (
                <div key={side} className="row gap">
                  <span className="side-label">{t(`side.${side}`)}</span>
                  <ModeSwitch value={modes[side]} onChange={(m) => setModes((x) => ({ ...x, [side]: m }))} />
                </div>
              ))}
            </div>
          )}
          {!backend.readOnly && <ModelPicker value={model} onChange={setModel} info={modelInfo} />}
          {err && <p className="err small">{t("common.actionFailed", { msg: err })}</p>}
          <button type="button" className="btn primary wide start-btn" onClick={start} disabled={busy} data-tour="arena-start">
            {backend.readOnly ? t("arena.replay") : busy ? t("common.working") : t("arena.start")}
          </button>
        </section>
      )}
    </div>
  );
}

/**
 * D30 relative price, by output price per 1M tokens against the cheapest option. "Cheapest" is unique:
 * on an output-price tie the lower input price wins (GLM $0.08 vs Haiku $0.10 in), so two models are
 * never both labelled "cheapest".
 */
export function modelPriceTier(id: ArenaModelChoice, list: readonly { id: ArenaModelChoice; price: { input: number; output: number } }[] = ARENA_MODELS): "cheapest" | "cheap" | "pricey" {
  const m = list.find((x) => x.id === id);
  if (!m) return "cheap";
  const min = Math.min(...list.map((x) => x.price.output));
  if (m.price.output >= 4 * min) return "pricey";
  const cheapest = [...list].sort((a, b) => a.price.output - b.price.output || a.price.input - b.price.input)[0];
  return cheapest?.id === id ? "cheapest" : "cheap";
}

/** One price badge per model: the tier, plus the catch when there is one ("Cheapest · slower"). */
export function modelPriceBadge(m: { slow?: boolean }, tier: "cheapest" | "cheap" | "pricey", t: (k: MsgKey) => string): string {
  return m.slow ? `${t(TIER_KEY[tier])} · ${t("arena.modelSlow")}` : t(TIER_KEY[tier]);
}

const TIER_KEY = { cheapest: "arena.modelCheapest", cheap: "arena.modelCheap", pricey: "arena.modelPricey" } as const;

export function modelLabel(s: Pick<ArenaSession, "modelChoice" | "model">): string | undefined {
  const byChoice = ARENA_MODELS.find((m) => m.id === s.modelChoice);
  const byModel = ARENA_MODELS.find((m) => m.model === s.model);
  // the concrete model wins when it matches a known one (env override may differ from the choice's default)
  return byModel?.label ?? (s.model ? s.model : byChoice?.label);
}

function ModelPicker({ value, onChange, info }: { value: ArenaModelChoice; onChange: (m: ArenaModelChoice) => void; info: ArenaModelsInfo | null }) {
  const { t } = useI18n();
  const models = info?.models?.length ? info.models : ARENA_MODELS.map((m) => ({ ...m, available: true }));
  const def = info?.default ?? DEFAULT_ARENA_MODEL;
  return (
    <div className="model-picker" role="radiogroup" aria-label={t("arena.model")} data-tour="arena-model">
      <div className="row gap">
        <span className="side-label">{t("arena.model")}</span>
        <span className="muted small">{t("arena.modelHint")}</span>
      </div>
      {info && !info.liveLLM && <p className="note warn-note small">{t("arena.modelUnavailable")}</p>}
      <div className="model-options">
        {models.map((m) => {
          const tier = modelPriceTier(m.id, models);
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === value}
              aria-label={`${m.label} · ${t(m.tee ? "arena.modelTee" : "arena.modelNoTee")} · ${t(TIER_KEY[tier])}${m.slow ? ` · ${t("arena.modelSlow")}` : ""}`}
              className={m.id === value ? "model-option on" : "model-option"}
              onClick={() => onChange(m.id)}
            >
              <span className="model-name">
                {m.label}
                {m.id === def && <span className="muted small"> · {t("arena.modelDefault")}</span>}
              </span>
              <span className="row gap-s">
                <Badge tone={m.tee ? "ok" : "muted"} title={t(m.tee ? "arena.modelTeeTitle" : "arena.modelNoTeeTitle")}>
                  {t(m.tee ? "arena.modelTee" : "arena.modelNoTee")}
                </Badge>
                <Badge tone={tier === "pricey" || m.slow ? "warn" : "info"} title={m.slow ? t("arena.modelSlowTitle") : undefined}>
                  {modelPriceBadge(m, tier, t)}
                </Badge>
              </span>
              <span className="muted small">{t("arena.modelPrice", { in: m.price.input, out: m.price.output })}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModeSwitch({ value, onChange, disabled }: { value: SideMode; onChange: (m: SideMode) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`segmented sm${disabled ? " disabled" : ""}`} role="radiogroup" aria-label={t("arena.mode")}>
      {MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={m === value} className={m === value ? "on" : ""} disabled={disabled} onClick={() => onChange(m)}>
          {t(`mode.${m}`)}
        </button>
      ))}
    </div>
  );
}

/* ───────────── live session ───────────── */

/**
 * Training mode (rate / rewrite each decoy line) starts on for a logged-in expert or reviewer: that is what
 * they are here for. Logged out, auth off (local demo) and read-only snapshots keep it off.
 */
export function defaultTrainingMode(id: { loggedIn: boolean }, readOnly: boolean): boolean {
  return id.loggedIn && !readOnly;
}

/** Expert name: the logged-in user when auth is on, otherwise a locally remembered name. */
export function useExpert(): [string, (v: string) => void, boolean] {
  const [local, setLocal] = useState(() => load(EXPERT_KEY) ?? "");
  const id = useIdentity(local);
  return [
    id.name,
    (v) => {
      if (!id.editable) return;
      setLocal(v);
      save(EXPERT_KEY, v.trim() ? v.trim() : null);
    },
    id.editable,
  ];
}

function LiveSession({
  initial, script, backend, snap, network,
}: { initial: ArenaSession; script?: ScamScriptDef; backend: Backend; snap: ViewSnapshot; network: ViewSnapshot["network"] }) {
  const { t } = useI18n();
  const [st, dispatch] = useReducer(arenaReducer, initialArena);
  const [err, setErr] = useState<string | null>(null);
  const identity = useIdentity("");
  const [training, setTraining] = useState(() => defaultTrainingMode(identity, backend.readOnly));
  // auth state can arrive after the session opened: switch on once when the login becomes known
  const autoOn = useRef(false);
  useEffect(() => {
    if (autoOn.current || !defaultTrainingMode(identity, backend.readOnly)) return;
    autoOn.current = true;
    setTraining(true);
  }, [identity, backend.readOnly]);

  useEffect(() => {
    dispatch({ type: "session", session: initial });
    return backend.subscribe(initial.id, (event) => dispatch({ type: "event", event }));
  }, [backend, initial]);

  const s = st.session;
  if (!s) return null;
  const act = (p: Promise<unknown>) => {
    setErr(null);
    p.catch((e: Error) => setErr(e.message));
  };
  const waitingHuman = s.status !== "finished" && s.modes[nextSide(s)] === "human";
  // the AI is answering (auto reply after a human line, or a step): one line at a time
  const typing = s.status !== "finished" ? st.typing : null;

  return (
    <SessionLayout
      session={s}
      script={script}
      snap={snap}
      network={network}
      txHashes={st.txHashes}
      safetyCount={st.safetyLog.length}
      err={err}
      training={training}
      setTraining={setTraining}
      backend={backend}
      controls={
        <>
          <button type="button" className="btn primary" disabled={s.status === "running" || s.status === "finished"} onClick={() => act(backend.control(s.id, "run"))}>
            ▶ {t("arena.run")}
          </button>
          <button type="button" className="btn" disabled={s.status !== "running"} onClick={() => act(backend.control(s.id, "pause"))}>
            ❚❚ {t("arena.pause")}
          </button>
          <button type="button" className="btn" disabled={s.status === "finished" || waitingHuman || !!typing} onClick={() => act(backend.control(s.id, "step"))}>
            ⇥ {t("arena.step1")}
          </button>
          {waitingHuman && !typing && <span className="badge tone-accent">{t("arena.waitingHuman", { side: t(`side.${nextSide(s)}`) })}</span>}
        </>
      }
      onMode={(side, m) => act(backend.setMode(s.id, side, m))}
      pending={st.pending}
      typing={typing}
      onSay={(side, text) => void sendSay(backend, s.id, side, text, dispatch)}
      onRetrySay={(p) => void sendSay(backend, s.id, p.side, p.text, dispatch, p.localId)}
      onDiscardSay={(p) => dispatch({ type: "sayDiscard", localId: p.localId })}
      onWhisper={(side, text) => backend.whisper(s.id, side, text)}
      onReview={(i, ok) => act(backend.review(s.id, i, ok))}
    />
  );
}

/* ───────────── replay (hosted) ───────────── */

function ReplaySession({ rec, script, snap, network }: { rec: ArenaSession; script?: ScamScriptDef; snap: ViewSnapshot; network: ViewSnapshot["network"] }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(true);
  const total = rec.turns.length;
  useEffect(() => {
    if (!playing || shown >= total) return;
    const tm = setTimeout(() => setShown((n) => n + 1), 1100);
    return () => clearTimeout(tm);
  }, [playing, shown, total]);
  const turns = rec.turns.slice(0, shown);
  const text = turns.map((x) => x.text.toLowerCase()).join("\n");
  const session: ArenaSession = {
    ...rec,
    turns,
    status: shown >= total ? "finished" : playing ? "running" : "paused",
    // A recorded draft becomes visible once the turn revealing its address has been replayed.
    drafts: rec.drafts.map((d) => (text.includes(d.address.toLowerCase()) ? d : { ...d, review: "hidden" as never })),
  };
  const done = shown >= total;
  return (
    <SessionLayout
      session={session}
      script={script}
      snap={snap}
      network={network}
      txHashes={{}}
      safetyCount={turns.filter((x) => x.safety).length}
      err={null}
      training={false}
      readOnly
      controls={
        <>
          <button type="button" className="btn primary" onClick={() => (done ? (setShown(0), setPlaying(true)) : setPlaying((p) => !p))}>
            {done ? `↺ ${t("arena.replayAgain")}` : playing ? `❚❚ ${t("arena.pause")}` : `▶ ${t("arena.run")}`}
          </button>
          <button type="button" className="btn" disabled={done} onClick={() => { setPlaying(false); setShown((n) => Math.min(total, n + 1)); }}>
            ⇥ {t("arena.step1")}
          </button>
          <span className="muted small">{t("arena.replayProgress", { a: shown, b: total })}</span>
        </>
      }
    />
  );
}

/* ───────────── shared layout ───────────── */

interface LayoutProps {
  session: ArenaSession;
  script?: ScamScriptDef;
  snap: ViewSnapshot;
  network: ViewSnapshot["network"];
  txHashes: Record<number, string>;
  safetyCount: number;
  err: string | null;
  controls: ReactNode;
  training: boolean;
  setTraining?: (v: boolean) => void;
  backend?: Backend;
  readOnly?: boolean;
  onMode?: (side: ArenaSide, m: SideMode) => void;
  pending?: PendingTurn[];
  /** side whose AI line is being generated ("typing…") */
  typing?: ArenaSide | null;
  onSay?: (side: ArenaSide, text: string) => void;
  onRetrySay?: (p: PendingTurn) => void;
  onDiscardSay?: (p: PendingTurn) => void;
  onWhisper?: (side: ArenaSide, text: string) => Promise<unknown>;
  onReview?: (i: number, approve: boolean) => void;
}

function SessionLayout(p: LayoutProps) {
  const { t } = useI18n();
  const s = p.session;
  const [expert, setExpert, expertEditable] = useExpert();
  const ro = !!p.readOnly;

  return (
    <div className="arena">
      <div className="card control-bar">
        <div className="row gap">{p.controls}</div>
        <div className="row gap push-md">
          <Badge tone={s.status === "running" ? "ok" : s.status === "finished" ? "muted" : "info"}>{t(`status.${s.status}`)}</Badge>
          <EngineBadge session={s} />
          <Switch checked={p.training} disabled={ro} title={ro ? t("arena.hostedHint") : undefined} onChange={(on) => p.setTraining?.(on)}>
            {t("training.mode")}
          </Switch>
        </div>
      </div>
      {s.engine === "rules" && <div className="rules-banner">{ro ? t("arena.rulesBannerReplay") : t("arena.rulesBanner")}</div>}
      {p.err && <p className="err small">{t("common.actionFailed", { msg: p.err })}</p>}
      {p.training && !ro && expertEditable && (
        <div className="card expert-bar">
          <label className="row gap">
            <span className="small">{t("training.expertName")}</span>
            <input className="input" value={expert} placeholder={t("training.expertPlaceholder")} onChange={(e) => setExpert(e.target.value)} />
          </label>
          <span className="muted small">{t("training.expertHint")}</span>
        </div>
      )}

      <div className="arena-grid">
        <section className="card chat2" aria-label={t("arena.conversation")}>
          <div className="chat2-head">
            {SIDES.map((side) => (
              <div key={side} className={`side-head ${side}`}>
                <div className="row gap">
                  <span className="avatar">{side === "scammer" ? "S" : "B"}</span>
                  <strong>{t(`side.${side}`)}</strong>
                </div>
                <ModeSwitch value={s.modes[side]} disabled={ro} onChange={(m) => p.onMode?.(side, m)} />
              </div>
            ))}
          </div>
          <div className="chat2-body" aria-live="polite">
            {s.turns.length === 0 && !p.pending?.length && <div className="empty small">{ro ? t("arena.replayEmpty") : t("arena.emptySession")}</div>}
            {s.turns.map((turn) => (
              <TurnRow
                key={turn.index}
                turn={turn}
                snap={p.snap}
                training={p.training && !ro}
                expert={expert}
                session={s}
                script={p.script}
                backend={p.backend}
              />
            ))}
            {p.pending?.map((pt) => (
              <PendingRow key={pt.localId} p={pt} snap={p.snap} onRetry={p.onRetrySay} onDiscard={p.onDiscardSay} />
            ))}
            {p.typing && (
              <div className={`turn-row ${p.typing} typing-row`} role="status">
                <div className="bubble2 typing">
                  <span className="typing-dots" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>{" "}
                  <span className="small">{t("arena.typing", { side: t(`side.${p.typing}`) })}</span>
                </div>
              </div>
            )}
          </div>
          <div className="chat2-foot" data-tour="arena-input">
            {SIDES.map((side) => (
              <SideInput
                key={side}
                side={side}
                mode={s.modes[side]}
                sideTurns={s.turns.filter((x) => x.side === side).length}
                disabled={ro || s.status === "finished"}
                onSay={p.onSay}
                onWhisper={p.onWhisper}
              />
            ))}
          </div>
        </section>

        <aside className="card drafts" aria-label={t("arena.drafts")}>
          <h2>{t("arena.drafts")}</h2>
          <DraftList session={s} network={p.network} txHashes={p.txHashes} readOnly={ro} onReview={p.onReview} />
          {p.safetyCount > 0 && <p className="note small">🛡 {t("arena.safetyCount", { n: p.safetyCount })}</p>}
        </aside>
      </div>
    </div>
  );
}

/** Engine + model of this session (D30). Rules mode: the picked model (if any) is shown as not used. */
export function EngineBadge({ session: s }: { session: Pick<ArenaSession, "engine" | "modelChoice" | "model"> }) {
  const { t } = useI18n();
  const picked = ARENA_MODELS.find((m) => m.id === s.modelChoice)?.label;
  if (s.engine === "rules")
    return (
      <Badge tone="warn" title={picked ? t("arena.modelChosen", { name: picked }) : undefined}>
        {t("engine.rulesMode")}
      </Badge>
    );
  const name = modelLabel(s);
  return <Badge tone="info">{name ? t("arena.modelBadge", { name }) : t("arena.engine", { name: s.engine === "nearai" ? "NEAR AI" : "Claude" })}</Badge>;
}

export function TurnRow({
  turn, snap, training, expert, session, script, backend,
}: { turn: ArenaTurn; snap: ViewSnapshot; training: boolean; expert: string; session: ArenaSession; script?: ScamScriptDef; backend?: Backend }) {
  const { t, tl } = useI18n();
  const [showWhisper, setShowWhisper] = useState(false);
  const [showSafety, setShowSafety] = useState(false);
  return (
    <div className={`turn-row ${turn.side}`}>
      <div className={`bubble2${turn.safety ? " flagged" : ""}`}>
        <div className="turn-meta">
          <span className="turn-idx">#{turn.index}</span>
          {turn.author === "human" && <span className="mini-chip human">{t("arena.human")}</span>}
          {turn.whisper && (
            <button type="button" className="mini-chip whisper" onClick={() => setShowWhisper((v) => !v)} title={t("arena.whisperMark")}>
              ✎ {t("arena.whisperMark")}
            </button>
          )}
          {turn.safety && (
            <button type="button" className="mini-chip safety" onClick={() => setShowSafety((v) => !v)}>
              🛡 {t("arena.safetyMark")}
            </button>
          )}
          <time className="push">{fmtClock(turn.ts)}</time>
        </div>
        <div className="bubble-text">
          <RichText text={turn.text} alerts={snap.alerts} />
        </div>
        {showWhisper && turn.whisper && (
          <div className="aside-note whisper-note">
            <b>{t("arena.whisperLabel")}</b> {turn.whisper}
          </div>
        )}
        {showSafety && turn.safety && (
          <div className="aside-note safety-note">
            <b title={turn.safety.rule}>{t("arena.safetyRule", { rule: tl("rule", turn.safety.rule) })}</b>
            {turn.safety.original ? (
              <>
                <div className="small muted">{t("arena.safetyOriginal")}</div>
                <del>{turn.safety.original}</del>
              </>
            ) : (
              <div className="small muted">{t("arena.safetyNoOriginal")}</div>
            )}
          </div>
        )}
        {training && turn.side === "bait" && backend && (
          <AnnotateBar turn={turn} expert={expert} session={session} script={script} backend={backend} />
        )}
      </div>
    </div>
  );
}

/** Optimistic human line: "sending" until the server turn replaces it, red with retry on failure. */
function PendingRow({ p, snap, onRetry, onDiscard }: { p: PendingTurn; snap: ViewSnapshot; onRetry?: (p: PendingTurn) => void; onDiscard?: (p: PendingTurn) => void }) {
  const { t } = useI18n();
  const failed = p.status === "failed";
  return (
    <div className={`turn-row ${p.side} pending-row`} data-status={p.status}>
      <div className={`bubble2 pending${failed ? " failed" : ""}`}>
        <div className="turn-meta">
          <span className="mini-chip human">{t("arena.human")}</span>
          {failed ? (
            <span className="mini-chip fail">{t("arena.sendFailed")}</span>
          ) : (
            <span className="mini-chip sending">
              <span className="spinner xs" /> {t("arena.sending")}
            </span>
          )}
          <time className="push">{fmtClock(p.ts)}</time>
        </div>
        <div className="bubble-text">
          <RichText text={p.text} alerts={snap.alerts} />
        </div>
        {failed && (
          <div className="pending-actions">
            {p.error && <div className="small err-inline">{t("common.actionFailed", { msg: p.error })}</div>}
            <div className="row gap">
              <button type="button" className="btn small primary" onClick={() => onRetry?.(p)}>
                {t("common.retry")}
              </button>
              <button type="button" className="btn small" onClick={() => onDiscard?.(p)}>
                {t("arena.discard")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type WhisperNotice = { text: string; state: "sent" | "failed"; error?: string; atTurns: number };
/** "Whispered" stays until the side speaks again (hint consumed); failures stay until retried. */
export function visibleWhisper(w: WhisperNotice | null, sideTurns: number): WhisperNotice | null {
  return w && (w.state === "failed" || sideTurns <= w.atTurns) ? w : null;
}

function SideInput({
  side, mode, sideTurns, disabled, onSay, onWhisper,
}: {
  side: ArenaSide;
  mode: SideMode;
  /** How many turns this side has spoken; a whisper is "used" once the side speaks again. */
  sideTurns: number;
  disabled: boolean;
  onSay?: (s: ArenaSide, t: string) => void;
  onWhisper?: (s: ArenaSide, t: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  // Whisper feedback is optimistic: shown on click, flips to failed + retry if the request errors.
  const [whisper, setWhisper] = useState<WhisperNotice | null>(null);
  // The hint is consumed by the side's next line: hide the "whispered" notice then.
  const whisperShown = visibleWhisper(whisper, sideTurns);
  if (mode === "ai") return <div className="side-input muted small">{t("arena.aiSpeaking", { side: t(`side.${side}`) })}</div>;
  const isSay = mode === "human";
  const sendWhisper = (v: string) => {
    setWhisper({ text: v, state: "sent", atTurns: sideTurns });
    Promise.resolve(onWhisper?.(side, v)).catch((e: Error) =>
      setWhisper((w) => (w && w.text === v ? { ...w, state: "failed", error: e?.message ?? String(e) } : w)),
    );
  };
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    if (isSay) onSay?.(side, v);
    else sendWhisper(v);
    setText("");
  };
  return (
    <div className={`side-input ${isSay ? "say" : "whisper"}`}>
      <label className="small">{isSay ? t("arena.sayAs", { side: t(`side.${side}`) }) : t("arena.whisperTo", { side: t(`side.${side}`) })}</label>
      <textarea
        className="input"
        rows={2}
        value={text}
        disabled={disabled}
        placeholder={isSay ? t("arena.sayPlaceholder") : t("arena.whisperPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="row gap">
        <button type="button" className="btn small primary" disabled={disabled || !text.trim()} onClick={submit}>
          {isSay ? t("arena.send") : t("arena.whisper")}
        </button>
        {!isSay && <span className="muted small push">{t("arena.whisperPrivate")}</span>}
      </div>
      {!isSay && whisperShown && (
        <div className={`whisper-status ${whisperShown.state}`} role="status">
          {whisperShown.state === "sent" ? (
            <>✓ {t("arena.whisperQueued")}</>
          ) : (
            <>
              <span>{t("arena.whisperFailed", { msg: whisperShown.error ?? "" })}</span>
              <button type="button" className="btn small" onClick={() => sendWhisper(whisperShown.text)}>
                {t("common.retry")}
              </button>
            </>
          )}
          <span className="whisper-text" title={whisperShown.text}>“{whisperShown.text}”</span>
        </div>
      )}
    </div>
  );
}

type DraftRow = ArenaSession["drafts"][number];

function DraftList({
  session, network, txHashes, readOnly, onReview,
}: { session: ArenaSession; network: ViewSnapshot["network"]; txHashes: Record<number, string>; readOnly: boolean; onReview?: (i: number, ok: boolean) => void }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<Set<number>>(new Set());
  const visible = session.drafts.map((d, i) => [d, i] as const).filter(([d]) => d && (d.review as string) !== "hidden");
  if (visible.length === 0) return <p className="muted small">{t("arena.noDrafts")}</p>;
  const review = (i: number, ok: boolean) => {
    setPending((s) => new Set(s).add(i));
    onReview?.(i, ok);
  };
  return (
    <ul className="draft-list">
      {visible.map(([d, i]) => (
        <DraftItem key={i} d={d} i={i} network={network} tx={txHashes[i]} readOnly={readOnly} busy={pending.has(i)} onReview={review} />
      ))}
    </ul>
  );
}

/** Where an approved address gets written, for the confirm text. */
export function registryWhereKey(network: string | undefined): MsgKey {
  return network === "testnet" ? "arena.whereTestnet" : network === "mainnet" ? "arena.whereMainnet" : "arena.whereLocal";
}

export function DraftItem({
  d, i, network, tx, readOnly, busy, onReview,
}: { d: DraftRow; i: number; network: ViewSnapshot["network"]; tx?: string; readOnly: boolean; busy: boolean; onReview: (i: number, ok: boolean) => void }) {
  const { t, tl } = useI18n();
  const { canReview } = useIdentity("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const txHash = tx ?? d.txHash;
  const url = nearTxUrl(network, txHash);
  return (
    <li className={`draft ${d.filteredReason ? "filtered" : d.review}`}>
      <div className="row gap">
        <ChainTag chain={d.chain} />
        <Mono value={d.address} head={8} tail={6} />
        <span className="push">
          <Badge tone="danger">{d.level}</Badge>
        </span>
      </div>
      <div className="muted small">{tl("type", d.category)}</div>
      {d.filteredReason ? (
        <div className="draft-state warn">
          {t("arena.filtered")}: <span className="small">{d.filteredReason}</span>
        </div>
      ) : d.review === "approved" ? (
        d.alertId !== undefined ? (
          <div className="draft-state ok">
            ✓ {t("arena.onChainAs", { id: d.alertId })}{" "}
            <a href={href("alerts", d.alertId)}>{t("arena.openAlert")}</a>
            {txHash && (
              <div className="small">
                {t("arena.tx")}{" "}
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="mono">
                    {short(txHash, 8, 6)} ↗
                  </a>
                ) : (
                  <Mono value={txHash} head={8} tail={6} />
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="draft-state">
            <span className="spinner" /> {t("arena.publishing")}
          </div>
        )
      ) : d.review === "rejected" ? (
        <div className="draft-state muted">{t("arena.rejected")}</div>
      ) : !canReview ? (
        <div className="draft-state muted">⏳ {t("auth.waitReviewer")}</div>
      ) : confirmReject ? (
        <div className="row gap draft-actions">
          <span className="small grow">{t("arena.rejectConfirm")}</span>
          <button type="button" className="btn small danger" disabled={readOnly || busy} onClick={() => (setConfirmReject(false), onReview(i, false))}>
            {t("arena.rejectYes")}
          </button>
          <button type="button" className="btn small" onClick={() => setConfirmReject(false)}>
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <div className="row gap draft-actions">
          <button type="button" className="btn small primary" disabled={readOnly || busy} onClick={() => setConfirmApprove(true)}>
            {busy ? t("common.working") : t("arena.approve")}
          </button>
          <button type="button" className="btn small" disabled={readOnly || busy} onClick={() => setConfirmReject(true)}>
            {t("arena.reject")}
          </button>
        </div>
      )}
      {/* publishing writes to the NEAR registry: confirm first, it cannot be taken back (only re-labelled later) */}
      <ConfirmDialog
        open={confirmApprove}
        title={t("arena.approveConfirmTitle")}
        body={t("arena.approveConfirmBody", { address: short(d.address, 8, 6), where: t(registryWhereKey(network)) })}
        confirmLabel={t("arena.approveConfirmYes")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          setConfirmApprove(false);
          onReview(i, true);
        }}
        onCancel={() => setConfirmApprove(false)}
      />
    </li>
  );
}

/* ───────────── training: annotate / rewrite ───────────── */

/**
 * One compact row per decoy line: 好 / 差 / 有风险 / ✎ 改写. "Good" is saved with one tap; "bad" / "risky"
 * open tags + reason (then save); "rewrite" opens tags + reason + the better line (then submit for review).
 */
export function AnnotateBar({ turn, expert, session, script, backend }: { turn: ArenaTurn; expert: string; session: ArenaSession; script?: ScamScriptDef; backend: Backend }) {
  const { t, tl } = useI18n();
  const [rating, setRating] = useState<TurnRating | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<"rate" | "rewrite" | null>(null);
  const [good, setGood] = useState(turn.text);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "submitted" | "error">("idle");
  const [msg, setMsg] = useState("");
  const prevScam = [...session.turns].reverse().find((x) => x.side === "scammer" && x.index < turn.index);
  const scammerTurns = session.turns.filter((x) => x.side === "scammer" && x.index < turn.index).length;
  const stage = Math.min(Math.max(0, (script?.stages.length ?? 1) - 1), Math.floor(scammerTurns / 2));
  const noExpert = !expert.trim();

  const toggle = (tag: string) => setTags((x) => (x.includes(tag) ? x.filter((y) => y !== tag) : [...x, tag]));
  const fail = (e: Error) => {
    setState("error");
    setMsg(e.message);
  };
  const saveAnn = (r: TurnRating | null = rating) => {
    if (!r) return;
    setState("saving");
    backend
      .postAnnotation({ sessionId: session.id, turnIndex: turn.index, expertId: expert.trim(), rating: r, tags, note })
      .then(() => {
        setState("saved");
        setOpen(null);
      }, fail);
  };
  const rate = (r: TurnRating) => {
    setRating(r);
    if (r === "good") {
      saveAnn("good");
      return;
    }
    setOpen("rate");
    if (state === "saved") setState("idle");
  };
  const submitCorrection = () => {
    setState("saving");
    backend
      .postCorrection({
        sessionId: session.id,
        turnIndex: turn.index,
        expertId: expert.trim(),
        scriptId: session.scriptId,
        scamType: script?.type ?? "investment",
        stage,
        situation: (prevScam?.text ?? "").slice(0, 160),
        badReply: turn.text,
        goodReply: good.trim(),
        rationale: note,
        tags,
      })
      .then(() => {
        setState("submitted");
        setOpen(null);
      }, fail);
  };

  if (noExpert) return <div className="annot muted small">{t("training.needExpert")}</div>;
  return (
    <div className={`annot${open ? " open" : " compact"}`}>
      <div className="annot-row" data-tour="arena-rate">
        {(["good", "bad", "risky"] as TurnRating[]).map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={rating === r}
            className={`rate rate-${r}${rating === r ? " on" : ""}`}
            disabled={state === "saving"}
            onClick={() => rate(r)}
          >
            {t(`rating.${r}`)}
          </button>
        ))}
        <button
          type="button"
          aria-expanded={open === "rewrite"}
          className={`rate rate-edit${open === "rewrite" ? " on" : ""}`}
          onClick={() => setOpen((o) => (o === "rewrite" ? null : "rewrite"))}
        >
          ✎ {t("training.rewriteShort")}
        </button>
        {state === "saved" && <span className="ok-text small">✓ {t("training.annotationSaved")}</span>}
        {state === "submitted" && <span className="ok-text small">✓ {t("training.correctionSubmitted")}</span>}
      </div>
      {open && (
        <>
          <div className="tag-pick">
            {TACTIC_TAGS.map((tag) => (
              <button key={tag} type="button" className={tags.includes(tag) ? "tag on" : "tag"} onClick={() => toggle(tag)}>
                {tl("tag", tag)}
              </button>
            ))}
          </div>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("training.notePlaceholder")} />
          {open === "rewrite" ? (
            <div className="rewrite">
              <label className="small">{t("training.goodReply")}</label>
              <textarea className="input" rows={3} value={good} onChange={(e) => setGood(e.target.value)} />
              <div className="row gap">
                <button type="button" className="btn small primary" disabled={!good.trim() || good.trim() === turn.text || state === "saving"} onClick={submitCorrection}>
                  {t("training.submitCorrection")}
                </button>
                <button type="button" className="btn small ghost" onClick={() => setOpen(null)}>
                  {t("training.collapse")}
                </button>
              </div>
            </div>
          ) : (
            <div className="row gap">
              <button type="button" className="btn small" disabled={!rating || state === "saving"} onClick={() => saveAnn()}>
                {t("training.saveAnnotation")}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setOpen(null)}>
                {t("training.collapse")}
              </button>
            </div>
          )}
        </>
      )}
      {state === "error" && <span className="err small">{t("common.actionFailed", { msg })}</span>}
    </div>
  );
}
