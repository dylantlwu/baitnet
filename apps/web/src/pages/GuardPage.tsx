import { useMemo, useState } from "react";
import type { GuardEvent, VerdictKind } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { ChainTag, Empty, PageHead, Segmented, VerdictBadge, VERDICT_TONE } from "../components/ui";
import { fmtTime, short } from "../lib/format";
import { href } from "../lib/router";
import { useI18n } from "../i18n";

type SourceFilter = "all" | GuardEvent["source"];
type KindFilter = "all" | VerdictKind;


export function GuardPage({
  snap, freshIds, alertFilter, live,
}: { snap: ViewSnapshot; freshIds: Set<string>; alertFilter?: number; live: boolean }) {
  const { t } = useI18n();
  const [source, setSource] = useState<SourceFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  // Expand the newest block of each source so the demo shows a refusal log straight away.
  const [open, setOpen] = useState<Set<string>>(() => {
    const ids = (["agent-wallet", "intents-solver"] as const)
      .map((src) => snap.events.find((e) => e.source === src && e.verdict.kind === "block")?.id)
      .filter((x): x is string => !!x);
    return new Set(ids);
  });

  const scoped = useMemo(
    () => snap.events.filter((e) => alertFilter === undefined || e.verdict.alert?.id === alertFilter),
    [snap.events, alertFilter],
  );
  const list = scoped.filter((e) => (source === "all" || e.source === source) && (kind === "all" || e.verdict.kind === kind));
  const count = (f: (e: GuardEvent) => boolean) => scoped.filter(f).length;
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <PageHead
        step={t("guard.step")}
        title={t("guard.title")}
        lead={t("guard.lead")}
      >
        <div className="stat-row">
          <div className="stat tone-danger">
            <strong>{count((e) => e.verdict.kind === "block")}</strong>
            <span>{t("guard.blocked")}</span>
          </div>
          <div className="stat tone-warn">
            <strong>{count((e) => e.verdict.kind === "warn")}</strong>
            <span>{t("guard.warned")}</span>
          </div>
          <div className="stat tone-ok">
            <strong>{count((e) => e.verdict.kind === "allow")}</strong>
            <span>{t("guard.allowed")}</span>
          </div>
        </div>
      </PageHead>

      <div className="toolbar">
        <Segmented
          label={t("guard.source")}
          value={source}
          onChange={setSource}
          options={[
            { value: "all", label: `${t("common.all")} ${scoped.length}` },
            { value: "agent-wallet", label: `${t("source.agent-wallet")} ${count((e) => e.source === "agent-wallet")}` },
            { value: "intents-solver", label: `${t("source.intents-solver")} ${count((e) => e.source === "intents-solver")}` },
          ]}
        />
        <Segmented
          label={t("guard.verdict")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: t("guard.any") },
            { value: "block", label: t("verdict.block") },
            { value: "warn", label: t("verdict.warn") },
            { value: "allow", label: t("verdict.allow") },
          ]}
        />
        {alertFilter !== undefined && (
          <a className="chip-link" href={href("guard")}>
            {t("alerts.alertN", { id: alertFilter })} ✕
          </a>
        )}
        {live && (
          <span className="live-hint">
            <span className="pulse" /> {t("guard.streaming")}
          </span>
        )}
      </div>

      {list.length === 0 ? (
        <Empty>{t("guard.empty")}</Empty>
      ) : (
        <ol className="events">
          {list.map((e) => {
            const isOpen = open.has(e.id);
            return (
              <li key={e.id} className={`event tone-${VERDICT_TONE[e.verdict.kind]}${freshIds.has(e.id) ? " fresh" : ""}`}>
                <button type="button" className="event-row" aria-expanded={isOpen} onClick={() => toggle(e.id)}>
                  <VerdictBadge kind={e.verdict.kind} />
                  <span className="event-main">
                    <span className="event-title">
                      <span className={`src src-${e.source}`}>{t(`source.${e.source}`)}</span>
                      <span className="arrow">→</span>
                      <strong>{t(`action.${e.action}`)}</strong>
                    </span>
                    <span className="event-target">
                      <ChainTag chain={e.verdict.target.chain} />
                      <code className="mono">{short(e.verdict.target.address, 10, 6)}</code>
                      {e.verdict.alert && <span className="muted small">{t("alerts.alertN", { id: e.verdict.alert.id })}</span>}
                    </span>
                  </span>
                  <time className="muted small nowrap">{fmtTime(e.at)}</time>
                  <span className="chev" aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
                {isOpen && (
                  <div className="event-body">
                    <h4>{t("guard.reasons")}</h4>
                    {e.verdict.reasons.length === 0 ? (
                      <p className="muted small">{t("guard.noSignals")}</p>
                    ) : (
                      <ul className="reasons">
                        {e.verdict.reasons.map((r, i) => (
                          <li key={i}>
                            <code className="signal" title={r.signal}>{t(`signal.${r.signal}`)}</code>
                            <span className="rdetail">{r.detail}</span>
                            <span className="weight" title={t("guard.weight", { n: r.weight })}>
                              <span style={{ width: `${Math.min(100, r.weight)}%` }} />
                              <em>{r.weight}</em>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <h4>{t("guard.log")}</h4>
                    <pre className="log">
                      {e.log.map((l, i) => (
                        <div key={i} className={logClass(l)}>
                          {l}
                        </div>
                      ))}
                    </pre>
                    {e.verdict.alert && (
                      <a className="muted small" href={href("alerts", e.verdict.alert.id)}>
                        {t("guard.openAlert", { id: e.verdict.alert.id })} →
                      </a>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function logClass(line: string): string {
  const l = line.toLowerCase();
  if (/refus|block|revert/.test(l)) return "l-bad";
  if (/warn|human|inject|override/.test(l)) return "l-warn";
  if (/signed|quote issued|finalized|allow/.test(l)) return "l-ok";
  return "";
}
