import { useEffect, useRef, useState, type ReactNode } from "react";
import { INTEL_SLOTS, type DecoyMind, type DecoyPersona, type DecoyTurnMind, type TurnRating } from "@baitnet/shared";
import { useI18n } from "../i18n";

/**
 * D32 "decoy mind" (docs/design/诱饵心智.md): the character card the decoy plays, its hidden notes per line,
 * and the running state (intel checklist, stated facts, does-the-scammer-look-like-a-bot, post-checks).
 * Team-only views. Every field is optional on the wire: old sessions and rules mode simply render nothing.
 */

/** Principle tags an expert can add after rating a decoy line (saved in Annotation.tags as-is). */
export const PRINCIPLE_TAGS: Partial<Record<TurnRating, readonly string[]>> = {
  good: ["p1-human", "p2-intel", "p3-logic"],
  bad: ["p1-ai-tell", "p2-no-intel", "p3-contradiction"],
};
export const ALL_PRINCIPLE_TAGS: readonly string[] = [...PRINCIPLE_TAGS.good!, ...PRINCIPLE_TAGS.bad!];

const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Phones: secondary panels start folded so the chat and its input keep the screen. */
const PHONE_MQ = "(max-width: 640px)";
const isPhone = () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_MQ).matches;

/** "林美华 · 46 · 佛山 · 在祖庙附近开一家小服装店" */
export function personaSummary(p: Pick<DecoyPersona, "name" | "age" | "city" | "job">): string {
  return [p.name, p.age, p.city, p.job].filter((x) => x !== undefined && x !== null && String(x).trim() !== "").join(" · ");
}

/* ───────────── persona line + card ───────────── */

/** One-line header above the chat; tap opens the full card (bottom sheet on phones, panel on desktop). */
export function PersonaLine({ persona }: { persona?: DecoyPersona }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!persona || !persona.name) return null;
  return (
    <>
      <button type="button" className="persona-line" onClick={() => setOpen(true)} aria-haspopup="dialog" data-tour="arena-persona">
        <span className="persona-line-label">{t("mind.persona")}</span>
        <span className="persona-line-text">{personaSummary(persona)}</span>
        <span className="persona-line-more" aria-hidden>
          {t("mind.personaOpen")} ›
        </span>
      </button>
      {open && <PersonaSheet persona={persona} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PersonaSheet({ persona: p, onClose }: { persona: DecoyPersona; onClose: () => void }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop sheet-backdrop" onClick={onClose}>
      <div className="card persona-sheet" role="dialog" aria-modal="true" aria-labelledby="persona-title" onClick={(e) => e.stopPropagation()}>
        <div className="persona-sheet-head">
          <div>
            <div className="eyebrow">{t("mind.personaTitle")}</div>
            <h2 id="persona-title">{p.name}</h2>
            <div className="muted small">{personaSummary({ ...p, name: "" })}</div>
          </div>
          <button ref={closeRef} type="button" className="btn small" onClick={onClose}>
            {t("training.collapse")}
          </button>
        </div>
        <p className="muted small">{t("mind.personaHint")}</p>
        <Field label={t("mind.p.background")}>{p.background}</Field>
        <Field label={t("mind.p.money")}>{p.money}</Field>
        <Field label={t("mind.p.family")}>{bullet(p.family)}</Field>
        <Field label={t("mind.p.routine")}>{p.routine}</Field>
        <Field label={t("mind.p.wants")}>{p.wants}</Field>
        <Field label={t("mind.p.limits")}>{bullet(p.limits)}</Field>
        <Field label={t("mind.p.knows")}>{chips(p.knows)}</Field>
        <Field label={t("mind.p.doesNotKnow")}>
          {arr(p.doesNotKnow).length > 0 && (
            <>
              <div className="muted small">{t("mind.p.doesNotKnowHint")}</div>
              {chips(p.doesNotKnow)}
            </>
          )}
        </Field>
        <Field label={t("mind.p.voice")}>
          {(p.voice?.style || arr(p.voice?.catchphrases).length > 0 || arr(p.voice?.quirks).length > 0) && (
            <>
              {p.voice?.style && <p>{p.voice.style}</p>}
              {arr(p.voice?.catchphrases).length > 0 && (
                <p>
                  <span className="muted small">{t("mind.p.catchphrases")}</span> {arr(p.voice?.catchphrases).map((c) => `「${c}」`).join(" ")}
                </p>
              )}
              {bullet(p.voice?.quirks)}
            </>
          )}
        </Field>
        <Field label={t("mind.p.stall")}>{bullet(p.stallExcuses)}</Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === undefined || children === null || children === false || children === "") return null;
  return (
    <section className="persona-field">
      <h4>{label}</h4>
      <div>{children}</div>
    </section>
  );
}
function bullet(xs: string[] | undefined) {
  const list = arr(xs);
  if (!list.length) return null;
  return (
    <ul>
      {list.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}
function chips(xs: string[] | undefined) {
  const list = arr(xs);
  if (!list.length) return null;
  return (
    <div className="tag-pick">
      {list.map((x) => (
        <span key={x} className="tag static">
          {x}
        </span>
      ))}
    </div>
  );
}

/* ───────────── per-line hidden note ───────────── */

/** "心里话" chip for the turn's meta line: true when this turn has something to show. */
export const hasTurnMind = (m?: DecoyTurnMind) => !!m && !!(m.think?.trim() || m.plan?.trim() || arr(m.newFacts).length);

export function TurnMindChip({ open, onToggle, title }: { open: boolean; onToggle: () => void; title?: string }) {
  const { t } = useI18n();
  return (
    <button type="button" className="mini-chip mind" aria-expanded={open} onClick={onToggle} title={title ?? t("mind.turnHint")}>
      💭 {t("mind.turn")}
    </button>
  );
}

export function TurnMindNote({ mind }: { mind: DecoyTurnMind }) {
  const { t } = useI18n();
  const facts = arr(mind.newFacts);
  return (
    <div className="aside-note mind-note">
      {mind.think?.trim() && (
        <div>
          <b>{t("mind.think")}</b> {mind.think}
        </div>
      )}
      {mind.plan?.trim() && (
        <div>
          <b>{t("mind.plan")}</b> {mind.plan}
        </div>
      )}
      {facts.length > 0 && (
        <div>
          <b>{t("mind.newFacts")}</b>
          <ul>
            {facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ───────────── running state card ───────────── */

export function intelCount(m?: Pick<DecoyMind, "intel">): number {
  const intel = m?.intel ?? {};
  return INTEL_SLOTS.filter((s) => typeof intel[s] === "string" && intel[s]!.trim() !== "").length;
}

/** Small "decoy mind" panel next to the chat. Folded by default on phones (`defaultOpen` overrides). */
export function DecoyMindCard({ mind, defaultOpen }: { mind?: DecoyMind; defaultOpen?: boolean }) {
  const { t, tl } = useI18n();
  const [open, setOpen] = useState(() => defaultOpen ?? !isPhone());
  if (!mind) return null;
  const intel = mind.intel ?? {};
  const facts = arr(mind.facts);
  const checks = arr(mind.checks);
  const score = typeof mind.scammerAi?.score === "number" ? Math.round(mind.scammerAi.score) : null;
  const signals = arr(mind.scammerAi?.signals);
  const got = intelCount(mind);
  return (
    <details className="mind-card" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-tour="arena-mind">
      <summary>
        <strong>{t("mind.card")}</strong>
        <span className="muted small">
          {t("mind.cardSummary", { got, total: INTEL_SLOTS.length })}
          {score !== null && ` · ${t("mind.botShort", { score })}`}
        </span>
      </summary>
      <div className="mind-body">
        <h4>{t("mind.intel", { got, total: INTEL_SLOTS.length })}</h4>
        <ul className="intel-list">
          {INTEL_SLOTS.map((slot) => {
            const v = typeof intel[slot] === "string" ? intel[slot]!.trim() : "";
            return (
              <li key={slot} className={v ? "has" : ""}>
                <span className="intel-mark" aria-hidden>
                  {v ? "✓" : "○"}
                </span>
                <span className="intel-label">{tl("intel", slot)}</span>
                {v ? (
                  <span className="intel-value" title={v}>
                    {clip(v, 28)}
                  </span>
                ) : (
                  <span className="sr-only">{t("mind.missing")}</span>
                )}
              </li>
            );
          })}
        </ul>

        {mind.plan?.trim() && (
          <p className="small mind-plan">
            <b>{t("mind.planNow")}</b> {mind.plan}
          </p>
        )}

        <details className="mind-sub">
          <summary>{t("mind.facts", { n: facts.length })}</summary>
          {facts.length === 0 ? (
            <p className="muted small">{t("mind.noFacts")}</p>
          ) : (
            <ol className="mind-list">
              {facts.map((f, i) => (
                <li key={i}>
                  <span className="turn-idx muted">#{f.turn}</span> {f.fact}
                </li>
              ))}
            </ol>
          )}
        </details>

        <div className="mind-bot">
          <span className="small">{t("mind.bot")}</span>
          {score === null ? (
            <span className="muted small">—</span>
          ) : (
            <span className={`mind-score ${score >= 60 ? "high" : score >= 30 ? "mid" : "low"}`}>{t("mind.score", { score })}</span>
          )}
          {signals.length > 0 && (
            <div className="tag-pick">
              {signals.map((s) => (
                <span key={s} className="tag static">
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>

        <details className="mind-sub">
          <summary>{t("mind.checks", { n: checks.length })}</summary>
          {checks.length === 0 ? (
            <p className="muted small">{t("mind.noChecks")}</p>
          ) : (
            <ul className="mind-list">
              {checks.map((c, i) => (
                <li key={i}>
                  <span className="turn-idx muted">#{c.turn}</span> <b>{tl("check", c.issue)}</b>
                  {c.detail && <span className="small"> · {c.detail}</span>}
                  {c.rewritten && <span className="mini-chip rewritten">{t("mind.rewritten")}</span>}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </details>
  );
}

/** Replay: only show what the decoy knew up to the last line on screen (facts / checks carry a turn index). */
export function mindUpTo(m: DecoyMind | undefined, lastTurnIndex: number): DecoyMind | undefined {
  if (!m) return m;
  return {
    ...m,
    facts: arr(m.facts).filter((f) => f.turn <= lastTurnIndex),
    checks: arr(m.checks).filter((c) => c.turn <= lastTurnIndex),
  };
}

/* ───────────── principle chips for the rating row ───────────── */

export function PrincipleChips({ rating, value, onToggle }: { rating: TurnRating | null; value: string[]; onToggle: (tag: string) => void }) {
  const { t, tl } = useI18n();
  const opts = rating ? PRINCIPLE_TAGS[rating] : undefined;
  if (!opts) return null;
  return (
    <div className="principle-pick" role="group" aria-label={t(rating === "good" ? "mind.whyGood" : "mind.whyBad")}>
      <span className="small muted-on-bubble">{t(rating === "good" ? "mind.whyGood" : "mind.whyBad")}</span>
      {opts.map((tag) => (
        <button key={tag} type="button" aria-pressed={value.includes(tag)} className={value.includes(tag) ? "tag on" : "tag"} onClick={() => onToggle(tag)}>
          {tl("tag", tag)}
        </button>
      ))}
    </div>
  );
}
