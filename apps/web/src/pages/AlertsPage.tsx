import { useEffect, useState } from "react";
import type { AlertView } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { RichText } from "../components/RichText";
import { Badge, ChainTag, Empty, LevelBadge, Mono, PageHead, StatusBadge, VerdictBadge } from "../components/ui";
import { conversationFor, verifyEvidence, type EvidenceCheck } from "../lib/evidence";
import { fmtClock, fmtTime, nearAccountUrl, nearTxUrl, short } from "../lib/format";
import { href } from "../lib/router";
import { useI18n } from "../i18n";

export function AlertsPage({ snap, alertId, apiBase }: { snap: ViewSnapshot; alertId?: number; apiBase: string | null }) {
  const { t, tl } = useI18n();
  const selected = snap.alerts.find((a) => a.id === alertId) ?? snap.alerts[0];
  return (
    <>
      <PageHead
        step={t("alerts.step")}
        title={t("alerts.title")}
        lead={t("alerts.lead")}
      >
        <div className="stat-row">
          <Stat n={snap.alerts.filter((a) => a.status === "Active").length} label={t("alerts.statActive")} />
          <Stat n={snap.alerts.filter((a) => a.level === "L1").length} label="L1" />
          <Stat n={snap.alerts.filter((a) => a.status === "Disputed").length} label={t("alerts.statDisputed")} />
        </div>
      </PageHead>
      {snap.alerts.length === 0 ? (
        <Empty>{t("alerts.empty")}</Empty>
      ) : (
        <div className="split">
          <section className="card list-card" aria-label={t("alerts.title")}>
            <table className="table alerts-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t("alerts.col.address")}</th>
                  <th>{t("alerts.col.level")}</th>
                  <th>{t("alerts.col.status")}</th>
                  <th>{t("alerts.col.reported")}</th>
                </tr>
              </thead>
              <tbody>
                {snap.alerts.map((a) => (
                  <tr
                    key={a.id}
                    className={a.id === selected?.id ? "sel" : ""}
                    onClick={() => (window.location.hash = href("alerts", a.id))}
                  >
                    <td className="num">{a.id}</td>
                    <td>
                      <a href={href("alerts", a.id)} className="cell-addr" onClick={(e) => e.stopPropagation()}>
                        <ChainTag chain={a.chain} />
                        <code className="mono">{short(a.address, 8, 6)}</code>
                      </a>
                      <div className="muted small cat">{tl("type", a.category)}</div>
                    </td>
                    <td>
                      <LevelBadge level={a.level} />
                    </td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="muted small nowrap">{fmtTime(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {selected && <AlertDetail key={selected.id} alert={selected} snap={snap} apiBase={apiBase} />}
        </div>
      )}
    </>
  );
}

const Stat = ({ n, label }: { n: number; label: string }) => (
  <div className="stat">
    <strong>{n}</strong>
    <span>{label}</span>
  </div>
);

function AlertDetail({ alert, snap, apiBase }: { alert: AlertView; snap: ViewSnapshot; apiBase: string | null }) {
  const { t, tl } = useI18n();
  const [check, setCheck] = useState<EvidenceCheck | "running">("running");
  const run = () => {
    setCheck("running");
    verifyEvidence(alert, snap, apiBase).then(setCheck, () =>
      setCheck({ status: "unavailable", expected: alert.evidenceHash, source: "error" }),
    );
  };
  useEffect(run, [alert.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const conv = conversationFor(alert, snap.conversations);
  const tx = nearTxUrl(snap.network, alert.txHash);
  const hits = snap.events.filter((e) => e.verdict.alert?.id === alert.id);
  const acks = snap.acks.filter((a) => a.alertId === alert.id);
  const flows = snap.flows[alert.id];
  const reporterUrl = nearAccountUrl(snap.network, alert.reporter);

  return (
    <section className="card detail" aria-label={t("alerts.alertN", { id: alert.id })}>
      <div className="detail-head">
        <h2>
          {t("alerts.alertN", { id: alert.id })} <LevelBadge level={alert.level} /> <StatusBadge status={alert.status} />
        </h2>
        <div className="addr-big">
          <ChainTag chain={alert.chain} />
          <Mono value={alert.address} full />
        </div>
      </div>

      <dl className="kv">
        <dt>{t("alerts.category")}</dt>
        <dd>{tl("type", alert.category)}</dd>
        <dt>{t("alerts.reporter")}</dt>
        <dd>{reporterUrl ? <a href={reporterUrl} target="_blank" rel="noreferrer">{alert.reporter}</a> : alert.reporter || "—"}</dd>
        <dt>{t("alerts.recorded")}</dt>
        <dd>{fmtTime(alert.createdAt)}</dd>
        <dt>{t("alerts.registryTx")}</dt>
        <dd>
          {alert.txHash ? (
            tx ? (
              <a href={tx} target="_blank" rel="noreferrer" className="mono">
                {short(alert.txHash, 10, 8)} ↗
              </a>
            ) : (
              <Mono value={alert.txHash} head={10} tail={8} />
            )
          ) : (
            "—"
          )}
          <span className="muted small"> · {snap.registryContract || t("alerts.registry")} ({tl("network", snap.network)})</span>
        </dd>
        <dt>{t("alerts.evidenceHash")}</dt>
        <dd>
          <code className="mono break small">{alert.evidenceHash}</code>
        </dd>
      </dl>

      <EvidenceBox check={check} onRerun={run} />

      {alert.status === "Disputed" && (
        <p className="note warn-note">
          {t("alerts.disputedNote")}
        </p>
      )}

      <div className="detail-links">
        <a href={href("guard") + `?alert=${alert.id}`} className="chip-link">
          {t("alerts.guardHits", { n: hits.length })}
          {hits[0] && <VerdictBadge kind={hits[0].verdict.kind} />}
        </a>
        <a href={href("responders")} className="chip-link">
          {t("alerts.acks", { n: acks.length })}
        </a>
        {flows?.length ? (
          <a href={href("flows", alert.id)} className="chip-link">
            {t("alerts.flowHops", { n: flows.length })} →
          </a>
        ) : null}
      </div>

      <h3>{t("alerts.evidenceRedacted")}</h3>
      {conv ? (
        <div className="transcript">
          {conv.turns.map((turn, i) => (
            <div key={i} className={`tline ${turn.role}`}>
              <span className="trole">{t(`side.${turn.role}`)}</span>
              <span className="tts">{fmtClock(turn.ts)}</span>
              <span className="ttext">
                <RichText text={turn.text} alerts={snap.alerts} />
              </span>
            </div>
          ))}
          <a className="muted small" href={href("replay", conv.id)}>
            {t("alerts.replayConv")} →
          </a>
        </div>
      ) : (
        <p className="muted">
          {t("alerts.noConv")}
          {alert.level === "L2" && ` ${t("alerts.l2Explain")}`}
        </p>
      )}
    </section>
  );
}

function EvidenceBox({ check, onRerun }: { check: EvidenceCheck | "running"; onRerun: () => void }) {
  const { t } = useI18n();
  const src = (c: EvidenceCheck) => t(`evidence.src.${c.source}`, { detail: c.detail ?? "" });
  if (check === "running")
    return (
      <div className="evidence-box running">
        <span className="spinner" /> {t("evidence.running")}
      </div>
    );
  if (check.status === "match")
    return (
      <div className="evidence-box ok">
        <div className="ev-title">✓ {t("evidence.ok")}</div>
        <div className="small">{t("evidence.okDetail", { bytes: check.bytes?.toLocaleString() ?? "?", src: src(check) })}</div>
        <button type="button" className="btn ghost small" onClick={onRerun}>
          {t("evidence.recompute")}
        </button>
      </div>
    );
  if (check.status === "mismatch")
    return (
      <div className="evidence-box bad">
        <div className="ev-title">✗ {t("evidence.bad")}</div>
        <div className="small">{t("evidence.badDetail", { hash: short(check.computed ?? "", 12, 12), src: src(check) })}</div>
        <button type="button" className="btn ghost small" onClick={onRerun}>
          {t("evidence.recompute")}
        </button>
      </div>
    );
  return (
    <div className="evidence-box muted-box">
      <div className="ev-title">{t("evidence.na")}</div>
      <div className="small">
        {t("evidence.naDetail")} <Badge tone="muted">{src(check)}</Badge>
      </div>
    </div>
  );
}
