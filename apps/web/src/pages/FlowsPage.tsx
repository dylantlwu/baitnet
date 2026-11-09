import type { AlertView, FlowEdge } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { ChainTag, Empty, LevelBadge, Mono, PageHead } from "../components/ui";
import { CHAIN_LABEL, fmtTime, fmtUsd, short } from "../lib/format";
import { layoutFlow } from "../lib/graph";
import { href } from "../lib/router";
import { useI18n } from "../i18n";

const isProtocolNode = (id: string) => id === "intents.near" || /^(intents|bridge|1click)/i.test(id);

export function FlowsPage({ snap, alertId }: { snap: ViewSnapshot; alertId?: number }) {
  const { t } = useI18n();
  const traced = snap.alerts.filter((a) => (snap.flows[a.id]?.length ?? 0) > 0);
  const alert = traced.find((a) => a.id === alertId) ?? traced[0];
  return (
    <>
      <PageHead
        step={t("flows.step")}
        title={t("flows.title")}
        lead={t("flows.lead")}
      />
      {!alert ? (
        <Empty>{t("flows.empty")}</Empty>
      ) : (
        <>
          {traced.length > 1 && (
            <nav className="toolbar" aria-label={t("flows.title")}>
              <div className="segmented">
                {traced.map((a) => (
                  <a key={a.id} href={href("flows", a.id)} className={a.id === alert.id ? "on" : ""}>
                    {t("alerts.alertN", { id: a.id })} · {CHAIN_LABEL[a.chain]}
                  </a>
                ))}
              </div>
            </nav>
          )}
          <FlowView alert={alert} edges={snap.flows[alert.id]} alerts={snap.alerts} />
        </>
      )}
    </>
  );
}

function FlowView({ alert, edges, alerts }: { alert: AlertView; edges: FlowEdge[]; alerts: AlertView[] }) {
  const { t, tl } = useI18n();
  const protoLabel = (p: string) => tl("protocol", p);
  const L = layoutFlow(edges);
  const flagged = (id: string) => alerts.find((a) => a.address.toLowerCase() === id.toLowerCase());
  const out = edges.filter((e) => e.from === alert.address).reduce((s, e) => s + (e.amountUsd ?? 0), 0);
  const chains = [...new Set(edges.map((e) => e.chain))];
  const times = edges.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const usesIntents = edges.some((e) => e.protocol.includes("intents"));

  return (
    <div className="flow-grid">
      <section className="card graph-card" aria-label={t("flows.title")}>
        <div className="flow-summary">
          <span>{t("flows.hops", { n: edges.length })}</span>
          <span>{t("flows.outOf", { amt: fmtUsd(out) || "—", id: alert.id })}</span>
          <span className="row gap-s">
            {chains.map((c) => (
              <ChainTag key={c} chain={c} />
            ))}
          </span>
          {usesIntents && <span className="badge tone-accent">{t("flows.viaIntents")}</span>}
          {times.length > 1 && <span className="muted small">{fmtTime(new Date(Math.min(...times)).toISOString())} → {fmtTime(new Date(Math.max(...times)).toISOString())}</span>}
        </div>
        <svg className="flow-svg" viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label={t("flows.graphLabel")}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" className="arrow-head" />
            </marker>
            <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" className="arrow-head hot" />
            </marker>
          </defs>
          {L.edges.map((e) => {
            const my = (e.y1 + e.y2) / 2;
            const d = `M${e.x1},${e.y1} C${e.x1},${my} ${e.x2},${my} ${e.x2},${e.y2 - 2}`;
            const hot = e.protocol.includes("intents");
            const lx = (e.x1 + e.x2) / 2;
            const l1 = `${protoLabel(e.protocol)} · ${CHAIN_LABEL[e.chain] ?? e.chain}`;
            const l2 = fmtUsd(e.amountUsd);
            const cw = (str: string) => [...str].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 11 : 6.4), 0);
            const w = Math.max(cw(l1), cw(l2)) + 14;
            return (
              <g key={e.key} className={hot ? "edge hot" : "edge"}>
                <path d={d} markerEnd={`url(#${hot ? "arrow-hot" : "arrow"})`} />
                <g transform={`translate(${lx},${my})`}>
                  <rect x={-w / 2} y={l2 ? -17 : -10} width={w} height={l2 ? 34 : 20} rx="6" className="edge-label-bg" />
                  <text y={l2 ? -3 : 4} textAnchor="middle" className="edge-label">
                    {l1}
                  </text>
                  {l2 && (
                    <text y={12} textAnchor="middle" className="edge-amt">
                      {l2}
                    </text>
                  )}
                </g>
              </g>
            );
          })}
          {L.nodes.map((n) => {
            const f = flagged(n.id);
            const root = n.id === alert.address;
            const proto = isProtocolNode(n.id);
            const cls = root ? "node root" : f ? `node flagged ${f.level}` : proto ? "node proto" : "node";
            return (
              <g key={n.id} className={cls} transform={`translate(${n.x},${n.y})`}>
                <title>{n.id}</title>
                <rect width={L.nodeW} height={L.nodeH} rx="10" />
                <text x={L.nodeW / 2} y={f || proto ? 20 : 29} textAnchor="middle" className="node-addr">
                  {proto ? "NEAR Intents" : short(n.id, 7, 5)}
                </text>
                {f && (
                  <text x={L.nodeW / 2} y={37} textAnchor="middle" className="node-tag">
                    {`#${f.id} · ${f.level}${root ? ` · ${t("flows.origin")}` : ""}`}
                  </text>
                )}
                {proto && !f && (
                  <text x={L.nodeW / 2} y={37} textAnchor="middle" className="node-tag">
                    {n.id}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div className="legend">
          <span>
            <i className="lg root" /> {t("flows.lg.root")}
          </span>
          <span>
            <i className="lg l2" /> {t("flows.lg.l2")}
          </span>
          <span>
            <i className="lg proto" /> {t("flows.lg.proto")}
          </span>
          <span>
            <i className="lg plain" /> {t("flows.lg.plain")}
          </span>
        </div>
      </section>

      <section className="card" aria-label={t("flows.hopList")}>
        <h2>{t("flows.hopList")}</h2>
        <ol className="hops">
          {[...edges]
            .sort((a, b) => (a.ts < b.ts ? -1 : 1))
            .map((e, i) => {
              const f = flagged(e.to);
              return (
                <li key={i}>
                  <div className="hop-top">
                    <span className="hop-n">{i + 1}</span>
                    <strong>{protoLabel(e.protocol)}</strong>
                    <ChainTag chain={e.chain} />
                    <span className="push amt">{fmtUsd(e.amountUsd)}</span>
                  </div>
                  <div className="hop-path">
                    <code className="mono">{short(e.from, 8, 5)}</code> → <code className="mono">{short(e.to, 8, 5)}</code>
                    {f && f.id !== alert.id && (
                      <a href={href("alerts", f.id)}>
                        <LevelBadge level={f.level} />
                      </a>
                    )}
                  </div>
                  <div className="muted small">
                    {fmtTime(e.ts)}
                    {e.txHash && (
                      <>
                        {` · ${t("arena.tx")} `}
                        <Mono value={e.txHash} head={6} tail={4} />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
        </ol>
      </section>
    </div>
  );
}
