import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { RichText } from "../components/RichText";
import { Badge, ChainTag, Empty, LevelBadge, Mono, PageHead } from "../components/ui";
import { tokenize } from "../lib/tokens";
import { fmtClock, fmtTime } from "../lib/format";
import { href } from "../lib/router";
import { useI18n } from "../i18n";


export function ReplayPage({ snap, convId }: { snap: ViewSnapshot; convId?: string }) {
  const { t, tl } = useI18n();
  const convs = snap.conversations;
  const conv = convs.find((c) => c.id === convId) ?? convs[0];
  if (!conv)
    return (
      <>
        <Head />
        <Empty>{t("replay.empty")}</Empty>
      </>
    );
  return (
    <>
      <Head />
      {convs.length > 1 && (
        <nav className="conv-picker" aria-label={t("replay.conversations")}>
          {convs.map((c) => (
            <a key={c.id} href={href("replay", c.id)} className={c.id === conv.id ? "conv-card on" : "conv-card"}>
              <strong>{tl("type", c.script)}</strong>
              <span className="muted small">
                {t("replay.turns", { n: c.turns.length })} · {tl("provider", c.provider)}
              </span>
            </a>
          ))}
        </nav>
      )}
      <Player key={conv.id} conv={conv} snap={snap} />
    </>
  );
}

function Head() {
  const { t } = useI18n();
  return <PageHead step={t("replay.step")} title={t("replay.title")} lead={t("replay.lead")} />;
}

function Player({ conv, snap }: { conv: Conversation; snap: ViewSnapshot }) {
  const { t, tl } = useI18n();
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(reduce ? conv.turns.length : 0);
  const [playing, setPlaying] = useState(!reduce);
  const [typing, setTyping] = useState(false);
  const [speed, setSpeed] = useState(1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const done = shown >= conv.turns.length;

  useEffect(() => {
    if (!playing || done) {
      setTyping(false);
      return;
    }
    const next = conv.turns[shown];
    const typeMs = Math.min(1600, 450 + next.text.length * 9) / speed;
    setTyping(true);
    const t = setTimeout(() => {
      setTyping(false);
      setShown((n) => n + 1);
    }, typeMs);
    return () => clearTimeout(t);
  }, [playing, shown, done, conv.turns, speed]);

  useEffect(() => {
    // Scroll only the chat pane, never the page.
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [shown, typing, reduce]);

  const findings = useMemo(() => {
    const addrs = new Map<string, { value: string; chain: string; turn: number }>();
    const urls = new Set<string>();
    let pii = 0;
    conv.turns.slice(0, shown).forEach((t, i) => {
      if (t.role !== "scammer") return;
      for (const tok of tokenize(t.text)) {
        if (tok.kind === "address" && !addrs.has(tok.value)) addrs.set(tok.value, { value: tok.value, chain: tok.chain, turn: i });
        if (tok.kind === "url") urls.add(tok.defanged);
        if (tok.kind === "pii") pii++;
      }
    });
    return { addrs: [...addrs.values()], urls: [...urls], pii };
  }, [conv, shown]);

  const nextRole = conv.turns[shown]?.role;

  return (
    <div className="replay-grid">
      <section className="card chat" aria-label={t("arena.conversation")}>
        <div className="chat-head">
          <div className="who scammer">
            <span className="avatar">S</span>
            <div>
              <strong>{t("side.scammer")}</strong>
              <div className="muted small">{t("replay.simulated")} · {tl("type", conv.script)}</div>
            </div>
          </div>
          <div className="who bait">
            <div className="right">
              <strong>{t("side.bait")}</strong>
              <div className="muted small">{tl("provider", conv.provider)}</div>
            </div>
            <span className="avatar">B</span>
          </div>
        </div>
        <div className="chat-body" aria-live="polite" ref={bodyRef}>
          {conv.turns.slice(0, shown).map((t, i) => (
            <div key={i} className={`bubble-row ${t.role}`}>
              <div className="bubble">
                <RichText text={t.text} alerts={snap.alerts} />
                <time className="ts">{fmtClock(t.ts)}</time>
              </div>
            </div>
          ))}
          {typing && nextRole && (
            <div className={`bubble-row ${nextRole}`}>
              <div className="bubble typing" aria-label={t("replay.typing")}>
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
        </div>
        <div className="chat-controls">
          <button type="button" className="btn primary" onClick={() => (done ? (setShown(0), setPlaying(true)) : setPlaying((p) => !p))}>
            {done ? `↺ ${t("arena.replayAgain")}` : playing ? `❚❚ ${t("arena.pause")}` : `▶ ${t("replay.play")}`}
          </button>
          <button type="button" className="btn" onClick={() => { setShown(conv.turns.length); setPlaying(false); }} disabled={done}>
            {t("replay.skip")}
          </button>
          <button type="button" className="btn ghost" onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}>
            {speed}×
          </button>
          <span className="muted small push">
            {t("replay.progress", { a: shown, b: conv.turns.length, at: fmtTime(conv.turns[0]?.ts ?? "") })}
          </span>
        </div>
      </section>

      <aside className="card findings" aria-label={t("replay.indicators")}>
        <h2>{t("replay.indicators")}</h2>
        {findings.addrs.length === 0 && findings.urls.length === 0 ? (
          <p className="muted small">{t("replay.waiting")}</p>
        ) : null}
        {findings.addrs.map((a) => {
          const alert = snap.alerts.find((x) => x.address.toLowerCase() === a.value.toLowerCase());
          return (
            <div key={a.value} className="finding pop">
              <div className="row gap">
                <ChainTag chain={a.chain as never} />
                <Mono value={a.value} />
              </div>
              {alert ? (
                <a className="finding-link" href={href("alerts", alert.id)}>
                  <LevelBadge level={alert.level} /> {t("arena.onChainAs", { id: alert.id })} →
                </a>
              ) : (
                <span className="muted small">{t("replay.pendingReview")}</span>
              )}
            </div>
          );
        })}
        {findings.urls.map((u) => (
          <div key={u} className="finding pop">
            <Badge tone="warn">{t("replay.phishingUrl")}</Badge>
            <code className="mono break">{u}</code>
          </div>
        ))}
        {findings.pii > 0 && (
          <p className="pii-note pop">
            <span className="pii">▇▇▇</span> {t("replay.piiNote", { n: findings.pii })}
          </p>
        )}
      </aside>
    </div>
  );
}
