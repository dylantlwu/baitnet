import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlertDraft, Correction, EvalRun, PlaybookEntry, ScamScriptDef, ScamType, ScriptAnalysis, ScriptUpload } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { useBackend } from "../backend/context";
import type { Backend } from "../backend/types";
import { Badge, Empty, PageHead, Segmented, LoadFailed, Switch } from "../components/ui";
import { LineChart } from "../components/LineChart";
import { RichText } from "../components/RichText";
import { useI18n } from "../i18n";
import { fmtTime } from "../lib/format";
import { href } from "../lib/router";
import { EXPERT_KEY, load, save } from "../lib/storage";
import { fileToUpload, pastedUpload, PASTE_MAX_CHARS, SCAM_TYPES } from "../scriptlab/analyze";
import { translateWarning } from "../i18n/vocab";
import { defang } from "../lib/tokens";
import { DraftItem, TACTIC_TAGS, reviewErrorText, useExpert } from "./ArenaPage";
import { AttestationFold } from "./TeePage";
import { NoEvalYet } from "./EvalPage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useAuth, useIdentity } from "../auth/context";

type Sub = "review" | "playbook" | "curve" | "upload";
const SUBS: Sub[] = ["review", "playbook", "curve", "upload"];

export function TrainingPage({ sub, snap }: { sub?: string; snap: ViewSnapshot }) {
  const { t } = useI18n();
  const backend = useBackend();
  const cur: Sub = (SUBS as string[]).includes(sub ?? "") ? (sub as Sub) : "review";
  return (
    <>
      <PageHead step={t("training.step")} title={t("training.title")} lead={t("training.lead")} />
      {backend?.readOnly && <p className="note info-note">{t("training.hostedHint")}</p>}
      <nav className="toolbar" aria-label={t("training.title")}>
        <div className="segmented">
          {SUBS.map((s) => (
            <a key={s} href={href("training", s)} className={s === cur ? "on" : ""} data-tour={s === "review" ? "training-review" : undefined}>
              {t(`training.sub.${s}`)}
            </a>
          ))}
        </div>
      </nav>
      {!backend ? (
        <div className="loading">
          <span className="spinner" /> {t("common.loading")}
        </div>
      ) : cur === "review" ? (
        <ReviewQueue backend={backend} />
      ) : cur === "playbook" ? (
        <PlaybookBrowser backend={backend} />
      ) : cur === "curve" ? (
        <Curve backend={backend} />
      ) : (
        <Upload backend={backend} network={snap.network} />
      )}
    </>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; err?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setErr(undefined);
    fn().then(
      (d) => alive && setData(d),
      (e: Error) => alive && setErr(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, err, reload: useCallback(() => setN((x) => x + 1), []) };
}

function LoadState({ err }: { err?: string }) {
  const { t } = useI18n();
  return err ? <LoadFailed msg={err} /> : <div className="loading"><span className="spinner" /> {t("common.loading")}</div>;
}

/* ───────────── review queue ───────────── */

function ReviewQueue({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  const { data, err, reload } = useLoad(() => backend.listCorrections(), [backend]);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [reviewer, setReviewer, editable] = useExpert();
  const { canReview } = useIdentity(reviewer);
  if (!data) return <LoadState err={err} />;
  const list = data.filter((c) => filter === "all" || c.review === "pending");
  const pendingN = data.filter((c) => c.review === "pending").length;

  return (
    <>
      <div className="toolbar">
        <Segmented
          label={t("training.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: t("training.pendingN", { n: pendingN }) },
            { value: "all", label: t("training.allN", { n: data.length }) },
          ]}
        />
        {/* experts do not review: no "reviewer <me>" label that reads as if they were one */}
        {canReview && (
          <label className="row gap push" data-testid="reviewer-label">
            <span className="small muted">{t("training.reviewer")}</span>
            {editable ? (
              <input className="input sm" value={reviewer} placeholder={t("training.expertPlaceholder")} onChange={(e) => setReviewer(e.target.value)} />
            ) : (
              <strong>{reviewer}</strong>
            )}
          </label>
        )}
      </div>
      {list.length === 0 ? (
        <Empty>{filter === "pending" ? t("training.noPending") : t("training.noCorrections")}</Empty>
      ) : (
        <ul className="corrections">
          {list.map((c) => (
            <CorrectionCard key={c.id} c={c} backend={backend} reviewer={reviewer} onDone={reload} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Who submitted / reviewed a rewrite, as names. With login on the server stores user ids and adds
 * `expertName` / `reviewerName` for logged-in callers; a bare id (u_xxxx) is never shown — it becomes
 * a neutral word instead. Local mode stores names already.
 */
export function peopleNames(c: Correction & { expertName?: string; reviewerName?: string }, someone: string): { expert: string; reviewer?: string } {
  const isId = (s: string | undefined) => !!s && /^u_[0-9a-f]{6,}$/i.test(s);
  const pick = (name: string | undefined, raw: string | undefined, fallback: string) => name || (isId(raw) ? fallback : raw);
  return { expert: pick(c.expertName, c.expertId, someone)!, reviewer: c.reviewer ? pick(c.reviewerName, c.reviewer, someone) : undefined };
}

/** One rewrite with bad/good side by side and approve / reject (reviewers only; not your own). */
export function CorrectionCard({ c, backend, reviewer, onDone }: { c: Correction; backend: Backend; reviewer: string; onDone: () => void }) {
  const { t, tl } = useI18n();
  const { canReview } = useIdentity(reviewer);
  const { state } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const myId = state?.kind === "user" ? state.me.expertId : null;
  const own = (!!myId && c.expertId === myId) || (!!reviewer.trim() && c.expertId.trim() === reviewer.trim());
  const names = peopleNames(c, t("training.someone"));
  const decide = async (ok: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      await backend.reviewCorrection(c.id, ok, reviewer.trim() || "reviewer");
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmReject(false);
    }
  };
  return (
    <li className="card correction">
      <div className="row gap">
        <Badge tone="muted">{tl("type", c.scamType)}</Badge>
        <span className="muted small">{t("training.stageN", { n: c.stage + 1 })}</span>
        <span className="muted small ellipsis">
          · {c.scriptId} · #{c.turnIndex}
        </span>
        <span className="push">
          <Badge tone={c.review === "approved" ? "ok" : c.review === "rejected" ? "muted" : "warn"}>{t(`review.${c.review}`)}</Badge>
        </span>
      </div>
      {c.situation && (
        <p className="situation small">
          <b>{t("training.situation")}</b> <RichText text={c.situation} alerts={[]} />
        </p>
      )}
      <div className="diff">
        <div className="diff-bad">
          <div className="diff-label">✗ {t("training.badReply")}</div>
          <RichText text={c.badReply} alerts={[]} />
        </div>
        <div className="diff-good">
          <div className="diff-label">✓ {t("training.goodReply")}</div>
          <RichText text={c.goodReply} alerts={[]} />
        </div>
      </div>
      {c.rationale && (
        <p className="small">
          <b>{t("training.rationale")}</b> {c.rationale}
        </p>
      )}
      <div className="row gap">
        {c.tags.map((tag) => (
          <span key={tag} className="tag static">
            {tl("tag", tag)}
          </span>
        ))}
        <span className="muted small push">
          {t("training.by", { who: names.expert, at: fmtTime(c.at) })}
          {names.reviewer && ` · ${t("training.reviewedBy", { who: names.reviewer })}`}
        </span>
      </div>
      {msg && <p className="err small">{t("common.actionFailed", { msg })}</p>}
      {c.review === "pending" &&
        (!canReview ? (
          <p className="muted small">⏳ {t("auth.waitReviewer")}</p>
        ) : own ? (
          <p className="muted small">{t("training.ownCorrection")}</p>
        ) : confirmReject ? (
          <div className="row gap review-actions">
            <span className="small grow">{t("training.rejectConfirm")}</span>
            <button type="button" className="btn small danger" disabled={busy} onClick={() => decide(false)}>
              {t("arena.rejectYes")}
            </button>
            <button type="button" className="btn small" onClick={() => setConfirmReject(false)}>
              {t("common.cancel")}
            </button>
          </div>
        ) : (
          <div className="row gap review-actions">
            <button type="button" className="btn small primary" disabled={backend.readOnly || busy} onClick={() => decide(true)}>
              {t("training.approve")}
            </button>
            <button type="button" className="btn small" disabled={backend.readOnly || busy} onClick={() => setConfirmReject(true)}>
              {t("training.rejectBtn")}
            </button>
            <span className="muted small">{t("training.approveHint")}</span>
          </div>
        ))}
    </li>
  );
}

/* ───────────── playbook ───────────── */

function PlaybookBrowser({ backend }: { backend: Backend }) {
  const { t, tl } = useI18n();
  const { data, err } = useLoad(() => backend.getPlaybook(), [backend]);
  const [type, setType] = useState<ScamType | "all">("all");
  const [stage, setStage] = useState<string>("all");
  const [tag, setTag] = useState<string>("all");
  if (!data) return <LoadState err={err} />;
  const stages = [...new Set(data.map((p) => String(p.stage)))].sort();
  const tags = [...new Set([...TACTIC_TAGS, ...data.flatMap((p) => p.tags)])];
  const list = data
    .filter(
      (p) =>
        (type === "all" || p.scamType === type || p.scamType === "any") &&
        (stage === "all" || String(p.stage) === stage || p.stage === "any") &&
        (tag === "all" || p.tags.includes(tag)),
    )
    .sort((a, b) => b.version - a.version);
  const version = Math.max(0, ...data.map((p) => p.version));

  return (
    <>
      <div className="toolbar">
        <select className="select" value={type} onChange={(e) => setType(e.target.value as ScamType | "all")} aria-label={t("arena.filterType")}>
          <option value="all">{t("arena.allTypes")}</option>
          {SCAM_TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {tl("type", ty)}
            </option>
          ))}
        </select>
        <select className="select" value={stage} onChange={(e) => setStage(e.target.value)} aria-label={t("training.stage")}>
          <option value="all">{t("training.allStages")}</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {s === "any" ? t("training.anyStage") : t("training.stageN", { n: Number(s) + 1 })}
            </option>
          ))}
        </select>
        <select className="select" value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t("training.tag")}>
          <option value="all">{t("training.allTags")}</option>
          {tags.map((x) => (
            <option key={x} value={x}>
              {tl("tag", x)}
            </option>
          ))}
        </select>
        <span className="muted small push">{t("training.playbookMeta", { n: list.length, v: version })}</span>
      </div>
      {list.length === 0 ? (
        <Empty>{t("training.noPlaybook")}</Empty>
      ) : (
        <ul className="playbook">
          {list.map((p) => (
            <PlaybookCard key={p.id} p={p} />
          ))}
        </ul>
      )}
    </>
  );
}

function PlaybookCard({ p }: { p: PlaybookEntry }) {
  const { t, tl } = useI18n();
  return (
    <li className="card pb">
      <div className="row gap">
        <Badge tone="info">v{p.version}</Badge>
        <Badge tone="muted">{p.scamType === "any" ? t("training.anyType") : tl("type", p.scamType)}</Badge>
        <span className="muted small">{p.stage === "any" ? t("training.anyStage") : t("training.stageN", { n: p.stage + 1 })}</span>
        {p.sourceCorrectionId && <span className="muted small push">{t("training.fromCorrection")}</span>}
      </div>
      <p className="situation small">
        <b>{t("training.situation")}</b> <RichText text={p.situation} alerts={[]} />
      </p>
      <div className="diff">
        {p.badReply && (
          <div className="diff-bad">
            <div className="diff-label">✗ {t("training.badReply")}</div>
            {p.badReply}
          </div>
        )}
        <div className="diff-good">
          <div className="diff-label">✓ {t("training.goodReply")}</div>
          {p.goodReply}
        </div>
      </div>
      <p className="small">
        <b>{t("training.rationale")}</b> {p.rationale}
      </p>
      <div className="row gap-s">
        {p.tags.map((tag) => (
          <span key={tag} className="tag static">
            {tl("tag", tag)}
          </span>
        ))}
      </div>
    </li>
  );
}

/* ───────────── improvement curve ───────────── */

export function Curve({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  const { data, err } = useLoad(() => backend.getEvalRuns(), [backend]);
  if (!data) return <LoadState err={err} />;
  if (data.length === 0) return <NoEvalYet what="curve" />;
  // One point per playbook version (latest run wins).
  const byV = new Map<number, EvalRun>();
  for (const r of [...data].sort((a, b) => (a.at < b.at ? -1 : 1))) byV.set(r.playbookVersion, r);
  const runs = [...byV.values()].sort((a, b) => a.playbookVersion - b.playbookVersion);
  const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
  // No regression cases yet (e.g. v1) = no data, not 0%.
  const regPct = (r: EvalRun) => (r.summary.regressionTotal ? (r.summary.regressionPassed / r.summary.regressionTotal) * 100 : null);
  const firstReg = runs.find((r) => r.summary.regressionTotal > 0);
  const maxCount = Math.max(1, ...runs.flatMap((r) => [r.summary.leaked, r.summary.hijacked]));
  const first = runs[0];
  const last = runs[runs.length - 1];
  return (
    <>
      <div className="stat-row wrap">
        <Delta label={t("curve.extractRate")} a={pct(first.summary.extracted, first.summary.total)} b={pct(last.summary.extracted, last.summary.total)} unit="%" />
        {firstReg && last.summary.regressionTotal > 0 && (
          <Delta label={t("curve.regressionRate")} a={regPct(firstReg)!} b={regPct(last)!} unit="%" />
        )}
        <Delta label={t("curve.leaked")} a={first.summary.leaked} b={last.summary.leaked} lowerIsBetter />
        <Delta label={t("curve.hijacked")} a={first.summary.hijacked} b={last.summary.hijacked} lowerIsBetter />
      </div>
      <div className="chart-grid">
        <div className="card">
          <LineChart
            title={t("curve.ratesTitle")}
            yMax={100}
            yFmt={(v) => `${Math.round(v)}%`}
            xLabel={(x) => `v${x}`}
            series={[
              { key: "ex", label: t("curve.extractRate"), color: "var(--c1)", points: runs.map((r) => ({ x: r.playbookVersion, y: pct(r.summary.extracted, r.summary.total) })) },
              { key: "rg", label: t("curve.regressionRate"), color: "var(--c2)", points: runs.map((r) => ({ x: r.playbookVersion, y: regPct(r) })) },
            ]}
            emptyLabel={t("curve.noRegression")}
          />
        </div>
        <div className="card">
          <LineChart
            title={t("curve.failuresTitle")}
            yMax={maxCount}
            integer
            yFmt={(v) => String(Math.round(v))}
            xLabel={(x) => `v${x}`}
            series={[
              { key: "lk", label: t("curve.leaked"), color: "var(--c3)", points: runs.map((r) => ({ x: r.playbookVersion, y: r.summary.leaked })) },
              { key: "hj", label: t("curve.hijacked"), color: "var(--c4)", points: runs.map((r) => ({ x: r.playbookVersion, y: r.summary.hijacked })) },
            ]}
          />
        </div>
      </div>
      {runs.some((r) => !r.summary.regressionTotal) && <p className="muted small">{t("curve.noRegressionNote")}</p>}
      <p className="muted small">{t("curve.note", { n: runs.length, engine: last.engine === "rules" ? t("engine.rulesMode") : last.engine === "nearai" ? "NEAR AI" : "Claude" })}</p>
    </>
  );
}

function Delta({ label, a, b, unit = "", lowerIsBetter }: { label: string; a: number; b: number; unit?: string; lowerIsBetter?: boolean }) {
  const d = b - a;
  const good = lowerIsBetter ? d < 0 : d > 0;
  const fmt = (v: number) => `${Math.round(v)}${unit}`;
  return (
    <div className="stat">
      <strong>{fmt(b)}</strong>
      <span>{label}</span>
      {d !== 0 && <em className={good ? "up good" : "up bad"}>{`${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))}`}</em>}
    </div>
  );
}

/* ───────────── upload / Script Lab ───────────── */

function Upload({ backend, network }: { backend: Backend; network: ViewSnapshot["network"] }) {
  const { t } = useI18n();
  const [expert, setExpert, expertEditable] = useExpert();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
  const [ephemeral, setEphemeral] = useState(false);
  const [pasted, setPasted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = backend.readOnly;

  const handle = async (file?: File) => {
    if (!file || disabled) return;
    if (!expert.trim()) {
      setErr(t("upload.needExpert"));
      return;
    }
    if (ephemeral && isImageFile(file)) {
      setErr(t("upload.ephemeralNoImage"));
      return;
    }
    if (file.size > 2_000_000) {
      setErr(t("upload.tooLarge"));
      return;
    }
    await analyze(() => fileToUpload(file, expert.trim()));
  };

  /** Pasted chat text: the same analysis as a .txt file ("pasted.txt"), zero-retention switch included. */
  const handlePaste = async () => {
    if (disabled || busy) return;
    if (!expert.trim()) {
      setErr(t("upload.needExpert"));
      return;
    }
    if (pasted.length > PASTE_MAX_CHARS) {
      setErr(t("upload.tooLarge"));
      return;
    }
    const u = pastedUpload(pasted, expert.trim());
    if (u) await analyze(async () => u);
  };

  const analyze = async (make: () => Promise<ScriptUpload>) => {
    setErr(null);
    setBusy(true);
    setAnalysis(null);
    try {
      setAnalysis(await backend.upload(await make(), { ephemeral }));
    } catch (e) {
      const m = (e as Error).message;
      setErr(
        m === "image-needs-vision"
          ? t("upload.imageNeedsKey")
          : /ephemeral-image/.test(m)
            ? t("upload.ephemeralNoImage")
            : m === "invalid-json" || m === "unknown-json"
              ? t("upload.badJson")
              : t("common.actionFailed", { msg: m }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card upload-card" data-tour="training-upload">
        {/* logged in: the server takes the identity from the session cookie, no name field */}
        {expertEditable && (
          <label className="row gap">
            <span className="small">{t("training.expertName")}</span>
            <input
              className="input sm"
              value={expert}
              disabled={disabled}
              placeholder={t("training.expertPlaceholder")}
              onChange={(e) => setExpert(e.target.value)}
            />
          </label>
        )}
        <div className={`zr-toggle${ephemeral ? " on" : ""}`}>
          <Switch
            checked={ephemeral}
            disabled={disabled}
            onChange={(on) => {
              setEphemeral(on);
              setErr(null);
            }}
          >
            <strong>{t("upload.ephemeral")}</strong>
          </Switch>
          <span className="muted small">{ephemeral ? t("upload.ephemeralOnHint") : t("upload.ephemeralOffHint")}</span>
        </div>
        <div
          className={`dropzone${drag ? " drag" : ""}${disabled ? " disabled" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            handle(e.dataTransfer.files[0]);
          }}
          onClick={() => !disabled && inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !disabled && inputRef.current?.click()}
        >
          <input ref={inputRef} type="file" hidden accept={uploadAccept(ephemeral)} onChange={(e) => handle(e.target.files?.[0] ?? undefined)} />
          {busy ? (
            <>
              <span className="spinner" /> {t("upload.analyzing")}
            </>
          ) : (
            <>
              <strong>{t("upload.drop")}</strong>
              <span className="muted small">{ephemeral ? t("upload.formatsEphemeral") : t("upload.formats")}</span>
              <span className="muted small">{t(ephemeral ? "upload.privacyEphemeral" : "upload.privacy")}</span>
            </>
          )}
        </div>
        <div className="paste-box">
          <label className="small" htmlFor="upload-paste">
            {t("upload.pasteLabel")}
          </label>
          <textarea
            id="upload-paste"
            className="input"
            rows={6}
            value={pasted}
            disabled={disabled || busy}
            placeholder={t("upload.pastePlaceholder")}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="row gap">
            <button type="button" className="btn primary small" disabled={disabled || busy || !pasted.trim()} onClick={() => void handlePaste()}>
              {busy ? t("upload.analyzing") : t("upload.pasteSubmit")}
            </button>
            {pasted.trim() && <span className="muted small">{t("upload.pasteCount", { n: pasted.trim().split(/\n+/).length })}</span>}
          </div>
        </div>
        {err && <p className="err small">{err}</p>}
      </div>
      {analysis && <AnalysisView key={analysis.id} a={analysis} backend={backend} network={network} expert={expert} />}
      {!analysis && !busy && <p className="muted small">{t("upload.hint")}</p>}
    </>
  );
}

/** Stage line range for display. ScriptAnalysis line numbers are already 1-based (server and local analyzer). */
export const stageLines = (s: { fromLine: number; toLine: number }) => ({ a: s.fromLine, b: s.toLine });

/** Accepted file types: no screenshots in zero-retention mode (they need Claude vision, which is not in the TEE). */
export function uploadAccept(ephemeral: boolean): string {
  return ephemeral ? ".txt,.md,.json,text/plain,text/markdown,application/json" : ".txt,.md,.json,.png,.jpg,.jpeg,.webp,image/*";
}
export const isImageFile = (f: { name: string; type?: string }) => (f.type ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(f.name);

/** An ephemeral (zero-retention) analysis must be confirmed before anything is written server-side. */
export const needsSaveConfirm = (a: ScriptAnalysis) => a.ephemeral === true;

export function AnalysisView({ a, backend, network, expert }: { a: ScriptAnalysis; backend: Backend; network: ViewSnapshot["network"]; expert: string }) {
  const { t, tl, lang } = useI18n();
  // Ephemeral results exist only in this browser until the user confirms "save".
  const [stored, setStored] = useState(!a.ephemeral);
  // Backend tactic codes (rapport, profit-lure…) live under tag.*, the local analyzer's under tactic.*.
  const tactic = (x: string) => {
    const a1 = tl("tactic", x);
    return a1 !== x ? a1 : tl("tag", x);
  };
  const warning = (w: string) => {
    const k = tl("warning", w);
    return k !== w ? k : translateWarning(w, lang);
  };
  // Merge PII findings of the same kind ("姓名 ×17 · 姓名 ×2" -> "姓名 ×19").
  const piiMerged = Object.entries(
    a.pii.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + p.count }), {}),
  );
  const lines = useMemo(() => a.redactedText.split("\n"), [a.redactedText]);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [review, setReview] = useState<Record<number, { state: "pending" | "approved" | "rejected"; alertId?: number; tx?: string; busy?: boolean }>>({});
  const doReview = async (i: number, ok: boolean, confirmWarnings?: boolean) => {
    setReviewErr(null);
    setReview((r) => ({ ...r, [i]: { state: "pending", busy: true } }));
    try {
      const res = await backend.reviewUploadDraft(a.id, i, ok, confirmWarnings);
      setReview((r) => ({ ...r, [i]: { state: ok ? "approved" : "rejected", alertId: res.alertId, tx: res.txHash } }));
    } catch (e) {
      setReview((r) => ({ ...r, [i]: { state: "pending" } }));
      setReviewErr(reviewErrorText(e, t));
    }
  };
  const draftRow = (d: AlertDraft, i: number) => {
    const r = review[i];
    return { ...d, review: r?.state ?? ("pending" as const), alertId: r?.alertId };
  };

  return (
    <div className="analysis">
      {a.ephemeral && (
        <div className="zr-banner" role="status">
          <strong>🔒 {stored ? t("upload.zrSavedTitle") : t("upload.zrBanner")}</strong>
          <span className="small">{stored ? t("upload.zrSavedNow") : t("upload.zrBannerDetail")}</span>
        </div>
      )}
      {a.ephemeral &&
        (a.attestation ? (
          <section aria-label={t("upload.zrAttestation")}>
            <h2 className="section-h">{t("upload.zrAttestation")}</h2>
            <AttestationFold a={a.attestation} />
          </section>
        ) : (
          <p className="note warn-note">{t("upload.zrNoAttestation")}</p>
        ))}
      <div className="card">
        <div className="row gap">
          <h2 className="grow">{t("upload.result", { file: a.filename })}</h2>
          <Badge tone={a.engine === "rules" ? "warn" : "info"}>{a.engine === "rules" ? t("engine.rulesMode") : t("arena.engine", { name: a.engine === "nearai" ? "NEAR AI" : "Claude" })}</Badge>
        </div>
        <dl className="kv">
          <dt>{t("upload.format")}</dt>
          <dd>{tl("format", a.format)}</dd>
          <dt>{t("upload.lang")}</dt>
          <dd>{a.lang === "zh" ? t("lang.zh") : t("lang.en")}</dd>
          <dt>{t("upload.type")}</dt>
          <dd>
            <div className="conf">
              <strong>{tl("type", a.scamType.value)}</strong>
              <span className="conf-bar">
                <span style={{ width: `${Math.round(a.scamType.confidence * 100)}%` }} />
              </span>
              <span className="small">{Math.round(a.scamType.confidence * 100)}%</span>
            </div>
            {a.scamType.alternatives.length > 0 && (
              <div className="muted small">
                {t("upload.alternatives")} {a.scamType.alternatives.map((x) => `${tl("type", x.value)} ${Math.round(x.confidence * 100)}%`).join(" · ")}
              </div>
            )}
          </dd>
          <dt>{t("upload.pii")}</dt>
          <dd>{piiMerged.length ? piiMerged.map(([kind, n]) => `${tl("pii", kind)} ×${n}`).join(" · ") : t("upload.noPii")}</dd>
        </dl>
        {a.warnings.length > 0 && (
          <ul className="warnings">
            {a.warnings.map((w) => (
              <li key={w}>⚠ {warning(w)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="analysis-grid">
        <div className="card">
          <h3 className="first">{t("upload.timeline")}</h3>
          <div className="timeline">
            {a.stages.map((s, i) => (
              <div key={i} className="tl-stage" style={{ flexGrow: Math.max(1, s.toLine - s.fromLine + 1) }}>
                <div className="tl-bar" />
                <strong className="small">{s.name}</strong>
                <span className="muted small">{t("upload.lines", stageLines(s))}</span>
                <span className="row gap-s">
                  {s.tactics.map((x) => (
                    <span key={x} className="tag static">
                      {tactic(x)}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <h3>{t("upload.redacted")}</h3>
          <ol className="redacted">
            {lines.map((l, i) => (
              <li key={i} className={a.injections.some((inj) => l.includes(inj)) ? "inj" : ""}>
                <RichText text={l} alerts={[]} />
              </li>
            ))}
          </ol>
        </div>
        <div className="card">
          <h3 className="first">{t("upload.artifacts")}</h3>
          {a.artifacts.length === 0 ? (
            <p className="muted small">{t("upload.noArtifacts")}</p>
          ) : (
            <ul className="plain-list">
              {a.artifacts.map((x, i) => (
                <li key={i} className="small">
                  <Badge tone={x.kind === "address" ? "danger" : "warn"}>{tl("artifact", x.kind)}</Badge>{" "}
                  <code className="mono break">{x.kind === "url" ? defang(x.value) : x.value}</code>
                </li>
              ))}
            </ul>
          )}
          <h3>{t("upload.injections")}</h3>
          {a.injections.length === 0 ? (
            <p className="muted small">{t("upload.noInjections")}</p>
          ) : (
            <ul className="plain-list">
              {a.injections.map((x, i) => (
                <li key={i} className="inj-line small">
                  {x}
                </li>
              ))}
            </ul>
          )}
          <h3>{t("upload.alertDrafts")}</h3>
          {reviewErr && <p className="err small">{t("common.actionFailed", { msg: reviewErr })}</p>}
          {a.alertDrafts.length === 0 ? (
            <p className="muted small">{t("arena.noDrafts")}</p>
          ) : !stored ? (
            <>
              <ul className="plain-list">
                {a.alertDrafts.map((d, i) => (
                  <li key={i} className="small">
                    <code className="mono break">{d.address}</code>
                  </li>
                ))}
              </ul>
              <p className="muted small">{t("upload.zrReviewAfterSave")}</p>
            </>
          ) : (
            <ul className="draft-list">
              {a.alertDrafts.map((d, i) => (
                <DraftItem key={i} d={draftRow(d, i)} i={i} network={network} tx={review[i]?.tx} readOnly={backend.readOnly} busy={!!review[i]?.busy} onReview={doReview} />
              ))}
            </ul>
          )}
        </div>
      </div>
      <DraftForm analysis={a} backend={backend} expert={expert} onSaved={() => setStored(true)} />
    </div>
  );
}

function DraftForm({ analysis, backend, expert, onSaved }: { analysis: ScriptAnalysis; backend: Backend; expert: string; onSaved?: () => void }) {
  const { t, tl } = useI18n();
  const [d, setD] = useState<ScamScriptDef>(() => ({ ...analysis.draft, source: { citation: `uploaded by ${expert || "expert"}, ${analysis.filename}` } }));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState("");
  const set = <K extends keyof ScamScriptDef>(k: K, v: ScamScriptDef[K]) => setD((x) => ({ ...x, [k]: v }));
  const [confirming, setConfirming] = useState(false);
  const saveIt = async () => {
    setConfirming(false);
    setState("saving");
    try {
      const saved = await backend.saveScript(analysis.id, d, analysis.ephemeral ? analysis : undefined);
      setD(saved);
      setState("saved");
      onSaved?.();
    } catch (e) {
      setMsg((e as Error).message);
      setState("error");
    }
  };
  return (
    <section className="card draft-form" aria-label={t("upload.draftForm")}>
      <h2>{t("upload.draftForm")}</h2>
      <div className="form-grid">
        <label>
          <span>{t("form.id")}</span>
          <input className="input" value={d.id} onChange={(e) => set("id", e.target.value)} />
        </label>
        <label>
          <span>{t("form.title")}</span>
          <input className="input" value={d.title} onChange={(e) => set("title", e.target.value)} />
        </label>
        <label>
          <span>{t("upload.type")}</span>
          <select className="select" value={d.type} onChange={(e) => set("type", e.target.value as ScamType)}>
            {SCAM_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {tl("type", ty)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("upload.lang")}</span>
          <select className="select" value={d.lang} onChange={(e) => set("lang", e.target.value as "zh" | "en")}>
            <option value="zh">{t("lang.zh")}</option>
            <option value="en">{t("lang.en")}</option>
          </select>
        </label>
        <label className="span2">
          <span>{t("arena.persona")}</span>
          <input className="input" value={d.persona} onChange={(e) => set("persona", e.target.value)} placeholder={t("form.personaPh")} />
        </label>
        <label className="span2">
          <span>{t("form.hook")}</span>
          <textarea className="input" rows={2} value={d.hook} onChange={(e) => set("hook", e.target.value)} />
        </label>
        <label className="span2">
          <span>{t("arena.goal")}</span>
          <input className="input" value={d.goal} onChange={(e) => set("goal", e.target.value)} placeholder={t("form.goalPh")} />
        </label>
      </div>
      <h3>{t("arena.stages")}</h3>
      {d.stages.map((s, i) => (
        <div key={i} className="stage-edit">
          <input
            className="input"
            value={s.name}
            aria-label={t("form.stageName")}
            onChange={(e) => set("stages", d.stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <input
            className="input"
            value={s.objective}
            placeholder={t("form.objective")}
            onChange={(e) => set("stages", d.stages.map((x, j) => (j === i ? { ...x, objective: e.target.value } : x)))}
          />
          <textarea
            className="input"
            rows={2}
            value={s.sampleLines.join("\n")}
            placeholder={t("form.sampleLines")}
            onChange={(e) => set("stages", d.stages.map((x, j) => (j === i ? { ...x, sampleLines: e.target.value.split("\n") } : x)))}
          />
          <button type="button" className="btn small ghost" onClick={() => set("stages", d.stages.filter((_, j) => j !== i))}>
            {t("form.remove")}
          </button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => set("stages", [...d.stages, { name: t("form.newStage"), objective: "", sampleLines: [] }])}>
        + {t("form.addStage")}
      </button>
      <h3>{t("upload.injections")}</h3>
      <textarea className="input" rows={3} value={d.injections.join("\n")} onChange={(e) => set("injections", e.target.value.split("\n").filter(Boolean))} placeholder={t("form.onePerLine")} />
      <h3>{t("upload.artifacts")}</h3>
      {d.plantedArtifacts.map((x, i) => (
        <div key={i} className="artifact-edit">
          <span className="small">{tl("artifact", x.kind)}</span>
          <input
            className="input mono"
            value={x.value}
            onChange={(e) => set("plantedArtifacts", d.plantedArtifacts.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))}
          />
          <button type="button" className="btn small ghost" onClick={() => set("plantedArtifacts", d.plantedArtifacts.filter((_, j) => j !== i))}>
            {t("form.remove")}
          </button>
        </div>
      ))}
      <div className="row gap form-foot">
        <button type="button" className="btn primary" disabled={backend.readOnly || state === "saving" || !d.id.trim() || !d.title.trim()} onClick={() => (needsSaveConfirm(analysis) ? setConfirming(true) : void saveIt())}>
          {state === "saving" ? t("common.working") : t("upload.save")}
        </button>
        {state === "saved" && (
          <span className="ok-text small">
            ✓ {t("upload.saved")} <a href={href("arena")}>{t("upload.openArena")}</a>
          </span>
        )}
        {state === "error" && <span className="err small">{t("common.actionFailed", { msg })}</span>}
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("upload.zrConfirmTitle")}
        body={t("upload.zrConfirmBody")}
        confirmLabel={t("upload.zrConfirmYes")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void saveIt()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
