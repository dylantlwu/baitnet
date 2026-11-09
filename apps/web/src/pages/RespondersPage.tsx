import type { AckOutcome } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { Badge, ChainTag, Empty, PageHead } from "../components/ui";
import { fmtDuration, fmtTime, nearAccountUrl, short } from "../lib/format";
import { href } from "../lib/router";
import { useI18n } from "../i18n";

// Neutral tones on purpose: outcomes are facts, not grades.
const OUTCOME_TONE: Record<AckOutcome, string> = { Seen: "muted", Blocked: "info", Reported: "info" };

export function RespondersPage({ snap }: { snap: ViewSnapshot }) {
  const { t } = useI18n();
  const nameOf = (id: string) => snap.responders.find((r) => r.accountId === id)?.name ?? id;
  const rows = [...snap.acks]
    .map((a) => ({ ack: a, alert: snap.alerts.find((x) => x.id === a.alertId) }))
    .sort((a, b) => a.ack.alertId - b.ack.alertId || (a.ack.at < b.ack.at ? -1 : 1));

  return (
    <>
      <PageHead
        step={t("resp.step")}
        title={t("resp.title")}
        lead={t("resp.lead")}
      />
      <div className="resp-grid">
        <section className="card" aria-label={t("resp.registered")}>
          <h2>{t("resp.registered")}</h2>
          {snap.responders.length === 0 ? (
            <Empty>{t("resp.noResponders")}</Empty>
          ) : (
            <ul className="resp-list">
              {snap.responders.map((r) => {
                const url = nearAccountUrl(snap.network, r.accountId);
                const n = snap.acks.filter((a) => a.responder === r.accountId).length;
                return (
                  <li key={r.accountId}>
                    <span className="avatar sm">{r.name.slice(0, 1)}</span>
                    <div>
                      <strong>{r.name}</strong>
                      <div className="muted small">
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer">
                            {r.accountId}
                          </a>
                        ) : (
                          r.accountId
                        )}
                      </div>
                      <div className="muted small">
                        {t("resp.registeredAt", { at: fmtTime(r.registeredAt) })} · {t("alerts.acks", { n })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card" aria-label={t("resp.acks")}>
          <h2>{t("resp.acks")}</h2>
          {rows.length === 0 ? (
            <Empty>{t("resp.noAcks")}</Empty>
          ) : (
            <table className="table stack">
              <thead>
                <tr>
                  <th>{t("resp.col.alert")}</th>
                  <th>{t("resp.col.responder")}</th>
                  <th>{t("resp.col.received")}</th>
                  <th>{t("resp.col.acked")}</th>
                  <th>{t("resp.col.elapsed")}</th>
                  <th>{t("resp.col.outcome")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ ack, alert }, i) => (
                  <tr key={i}>
                    <td data-label={t("resp.col.alert")}>
                      <a href={href("alerts", ack.alertId)} className="cell-addr">
                        #{ack.alertId}
                        {alert && (
                          <>
                            <ChainTag chain={alert.chain} />
                            <code className="mono">{short(alert.address, 6, 4)}</code>
                          </>
                        )}
                      </a>
                    </td>
                    <td data-label={t("resp.col.responder")}>{nameOf(ack.responder)}</td>
                    <td data-label={t("resp.col.received")} className="small nowrap">
                      {ack.receivedAt ? fmtTime(ack.receivedAt) : alert ? fmtTime(alert.createdAt) : "—"}
                    </td>
                    <td data-label={t("resp.col.acked")} className="small nowrap">
                      {fmtTime(ack.at)}
                    </td>
                    <td data-label={t("resp.col.elapsed")} className="num">
                      {alert ? fmtDuration(Date.parse(ack.at) - Date.parse(ack.receivedAt ?? alert.createdAt)) : "—"}
                    </td>
                    <td data-label={t("resp.col.outcome")}>
                      <Badge tone={OUTCOME_TONE[ack.outcome] ?? "muted"}>{t(`outcome.${ack.outcome}`)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small foot">
            {t("resp.foot")}
          </p>
        </section>
      </div>
    </>
  );
}
