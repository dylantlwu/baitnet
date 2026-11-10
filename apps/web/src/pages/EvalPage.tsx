import { useEffect, useState } from "react";
import type { EvalCase, EvalReport, ScamScriptDef, ScamType } from "@baitnet/shared";
import { useBackend } from "../backend/context";
import { Badge, Empty, PageHead, Segmented, LoadFailed } from "../components/ui";
import { useI18n } from "../i18n";
import { fmtPct, fmtTime } from "../lib/format";
import { href } from "../lib/router";
import { SCAM_TYPES } from "../scriptlab/analyze";
import { useIdentity } from "../auth/context";

type Lang = "zh" | "en";

/** EvalCase has no lang field yet: take it from the script list, then from the id ("…-zh-01"). */
export function caseLang(c: EvalCase, scripts: Map<string, ScamScriptDef>): Lang | undefined {
  const s = scripts.get(c.scriptId);
  if (s) return s.lang;
  if (/(^|[-_.])zh([-_.]|$)/i.test(c.scriptId)) return "zh";
  if (/(^|[-_.])en([-_.]|$)/i.test(c.scriptId)) return "en";
  return undefined;
}

export function summarize(cases: EvalCase[]) {
  const ext = cases.filter((c) => c.extracted);
  const poison = cases.filter((c) => c.poisonFiltered !== undefined);
  const turns = ext.map((c) => c.turnsToExtract).filter((n): n is number => typeof n === "number");
  return {
    total: cases.length,
    extracted: ext.length,
    leaked: cases.filter((c) => c.leaked).length,
    hijacked: cases.filter((c) => c.hijacked).length,
    poisonTotal: poison.length,
    poisonFiltered: poison.filter((c) => c.poisonFiltered).length,
    onChain: cases.filter((c) => c.onChain).length,
    avgTurnsToExtract: turns.length ? turns.reduce((a, b) => a + b, 0) / turns.length : 0,
  };
}

/**
 * Empty report card / improvement curve. Experts are told who makes it appear (a reviewer runs an eval);
 * reviewers get a button that starts one here (offline rules run, no model calls).
 */
export function NoEvalYet({ what }: { what: "report" | "curve" }) {
  const { t } = useI18n();
  const backend = useBackend();
  const { canReview } = useIdentity("");
  const [state, setState] = useState<"idle" | "busy" | "started" | "error">("idle");
  const [msg, setMsg] = useState("");
  const reviewer = canReview;
  const canRun = reviewer && !!backend?.runEval && !backend.readOnly;
  const run = async () => {
    setState("busy");
    try {
      await backend!.runEval!();
      setState("started");
    } catch (e) {
      setMsg((e as Error).message);
      setState("error");
    }
  };
  return (
    <Empty>
      <p>{t(what === "report" ? "eval.emptyTitle" : "training.noRunsTitle")}</p>
      <p className="small">{reviewer ? t("eval.emptyReviewer") : t("eval.emptyExpert")}</p>
      {canRun && (
        <button type="button" className="btn primary small" disabled={state === "busy" || state === "started"} onClick={() => void run()}>
          {state === "busy" ? t("common.working") : t("eval.runNow")}
        </button>
      )}
      {state === "started" && <p className="ok-text small">{t("eval.runStarted")}</p>}
      {state === "error" && <p className="err small">{t("common.actionFailed", { msg })}</p>}
    </Empty>
  );
}

export function EvalPage() {
  const { t, tl } = useI18n();
  const backend = useBackend();
  const [report, setReport] = useState<EvalReport | null | undefined>();
  const [scripts, setScripts] = useState<Map<string, ScamScriptDef>>(new Map());
  const [err, setErr] = useState<string>();
  const [type, setType] = useState<ScamType | "all">("all");
  const [lang, setLang] = useState<"all" | Lang>("all");

  useEffect(() => {
    if (!backend) return;
    backend.getEval().then((r) => setReport(r ?? null), (e: Error) => setErr(e.message));
    backend.listScripts().then((s) => setScripts(new Map(s.map((x) => [x.id, x]))), () => undefined);
  }, [backend]);

  const head = <PageHead step={t("eval.step")} title={t("eval.title")} lead={t("eval.lead")} />;
  if (err) return <>{head}<LoadFailed msg={err} /></>;
  if (report === undefined) return <>{head}<div className="loading"><span className="spinner" /> {t("common.loading")}</div></>;
  if (report === null) return <>{head}<NoEvalYet what="report" /></>;

  const byLang = (l: Lang) => report.cases.filter((c) => caseLang(c, scripts) === l);
  const rows = report.cases.filter((c) => (type === "all" || c.type === type) && (lang === "all" || caseLang(c, scripts) === lang));
  const all = summarize(report.cases);

  return (
    <>
      {head}
      <div className="toolbar">
        <Badge tone={report.engine === "rules" ? "warn" : "info"}>{report.engine === "rules" ? t("engine.rulesMode") : t("arena.engine", { name: report.engine === "nearai" ? "NEAR AI" : "Claude" })}</Badge>
        <span className="muted small">{t("eval.generated", { at: fmtTime(report.generatedAt), n: report.cases.length })}</span>
        <a className="chip-link push" href={href("training", "curve")}>{t("eval.toCurve")}</a>
      </div>

      <div className="eval-summary">
        <SummaryCard title={t("eval.overall")} s={all} />
        <SummaryCard title={t("eval.zhScripts")} s={summarize(byLang("zh"))} />
        <SummaryCard title={t("eval.enScripts")} s={summarize(byLang("en"))} />
      </div>

      <div className="toolbar">
        <select className="select" value={type} onChange={(e) => setType(e.target.value as ScamType | "all")} aria-label={t("arena.filterType")}>
          <option value="all">{t("arena.allTypes")}</option>
          {SCAM_TYPES.map((ty) => (
            <option key={ty} value={ty}>{tl("type", ty)}</option>
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
        <span className="muted small push">{t("eval.rows", { n: rows.length })}</span>
      </div>

      <section className="card">
        {rows.length === 0 ? (
          <Empty>{t("eval.noRows")}</Empty>
        ) : (
          <table className="table stack eval-table">
            <thead>
              <tr>
                <th>{t("eval.col.script")}</th>
                <th>{t("eval.col.type")}</th>
                <th>{t("eval.col.lang")}</th>
                <th>{t("eval.col.extracted")}</th>
                <th>{t("eval.col.turns")}</th>
                <th>{t("eval.col.leaked")}</th>
                <th>{t("eval.col.hijacked")}</th>
                <th>{t("eval.col.poison")}</th>
                <th>{t("eval.col.onchain")}</th>
                <th>{t("eval.col.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const l = caseLang(c, scripts);
                return (
                  <tr key={c.scriptId} className={c.leaked || c.hijacked ? "row-bad" : ""}>
                    <td data-label={t("eval.col.script")}>
                      <code className="mono">{c.scriptId}</code>
                      {scripts.get(c.scriptId) && <div className="muted small">{scripts.get(c.scriptId)!.title}</div>}
                    </td>
                    <td data-label={t("eval.col.type")}>{tl("type", c.type)}</td>
                    <td data-label={t("eval.col.lang")}>{l ? t(`lang.${l}`) : "—"}</td>
                    <td data-label={t("eval.col.extracted")}><Mark ok={c.extracted} /></td>
                    <td data-label={t("eval.col.turns")} className="num">
                      {c.turnsToExtract ?? "—"} / {c.turns}
                    </td>
                    <td data-label={t("eval.col.leaked")}><Mark ok={!c.leaked} bad={c.leaked} /></td>
                    <td data-label={t("eval.col.hijacked")}><Mark ok={!c.hijacked} bad={c.hijacked} /></td>
                    <td data-label={t("eval.col.poison")}>{c.poisonFiltered === undefined ? <span className="muted">—</span> : <Mark ok={c.poisonFiltered} />}</td>
                    <td data-label={t("eval.col.onchain")}><Mark ok={c.onChain} /></td>
                    <td data-label={t("eval.col.notes")} className="small notes">{c.notes.join("; ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <p className="muted small">{t("eval.legend")}</p>
    </>
  );
}

function Mark({ ok, bad }: { ok: boolean; bad?: boolean }) {
  const { t } = useI18n();
  if (bad) return <span className="mark bad">✗ {t("eval.yes")}</span>;
  return ok ? <span className="mark ok">✓</span> : <span className="mark no">✗</span>;
}

function SummaryCard({ title, s }: { title: string; s: ReturnType<typeof summarize> }) {
  const { t } = useI18n();
  return (
    <section className="card sum-card">
      <h2>
        {title} <span className="muted small">{t("eval.nScripts", { n: s.total })}</span>
      </h2>
      {s.total === 0 ? (
        <p className="muted small">{t("eval.noRows")}</p>
      ) : (
        <div className="metrics">
          <Metric label={t("eval.m.extract")} value={fmtPct(s.extracted, s.total)} sub={`${s.extracted}/${s.total}`} tone="ok" />
          <Metric label={t("eval.m.avgTurns")} value={s.avgTurnsToExtract ? s.avgTurnsToExtract.toFixed(1) : "—"} />
          <Metric label={t("eval.m.leaked")} value={String(s.leaked)} tone={s.leaked ? "danger" : "ok"} />
          <Metric label={t("eval.m.hijacked")} value={String(s.hijacked)} tone={s.hijacked ? "danger" : "ok"} />
          <Metric label={t("eval.m.poison")} value={s.poisonTotal ? `${s.poisonFiltered}/${s.poisonTotal}` : "—"} />
          <Metric label={t("eval.m.onchain")} value={fmtPct(s.onChain, s.total)} sub={`${s.onChain}/${s.total}`} />
        </div>
      )}
    </section>
  );
}

const Metric = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) => (
  <div className={`metric${tone ? ` tone-${tone}` : ""}`}>
    <strong>{value}</strong>
    <span>{label}</span>
    {sub && <em>{sub}</em>}
  </div>
);
