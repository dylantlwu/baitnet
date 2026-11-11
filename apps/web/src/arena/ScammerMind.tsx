import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ArenaSession, ArenaSide, ArenaTurn, ScammerCard, ScammerMind, ScammerTurnMind, ScriptCover, SideMode } from "@baitnet/shared";
import { useI18n } from "../i18n";
import { TurnMindChip } from "./DecoyMind";

/**
 * D34 scammer side (docs/design/骗子人物卡.md): the mask the scammer wears (ScriptCover), the real person
 * behind the keyboard (ScammerCard), the hidden note behind each AI scammer line and the running scammer
 * state (suspicion that the "victim" is bait, stated facts, escalation actions).
 *
 * Visibility: a human playing the decoy must never get a god view of the scammer. All of this is shown only
 * when spectating (no human on the decoy side) or when the human plays the scammer. Every field is optional
 * on the wire: old sessions render nothing.
 */

export type ScammerAction = NonNullable<ScammerTurnMind["action"]>;
type Scammer = NonNullable<ArenaSession["scammer"]>;

const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
const PHONE_MQ = "(max-width: 640px)";
const isPhone = () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_MQ).matches;

/** A human on the decoy side (taking over, or whispering to the AI decoy) is "playing the decoy". */
export const humanPlaysBait = (modes?: Partial<Record<ArenaSide, SideMode>>) => modes?.bait === "human" || modes?.bait === "ai+whisper";

/**
 * D34 visibility rule: scammer card, mask details, scammer thoughts and the scammer mind card are shown only
 * when nobody plays the decoy (spectating both AIs, or the human plays the scammer). Unknown modes = hidden.
 */
export function scammerViewAllowed(modes?: Partial<Record<ArenaSide, SideMode>>): boolean {
  if (!modes || typeof modes !== "object") return false;
  return !humanPlaysBait(modes);
}

/** Server param on session creation (default "real": the scammer can get suspicious). */
export type ScammerMode = "easy" | "real";
export const DEFAULT_SCAMMER_MODE: ScammerMode = "real";
/** Defensive read: the field may be absent (older server) or anything else. */
export function sessionScammerMode(s: unknown): ScammerMode | undefined {
  const v = s && typeof s === "object" ? (s as { scammerMode?: unknown }).scammerMode : undefined;
  return v === "easy" || v === "real" ? v : undefined;
}

/** Short tag for the operator's setting: the first clause of `situation` ("缅北某园区，夜班…" → "缅北某园区"). */
export function situationTag(situation?: string): string {
  const first = (situation ?? "").split(/[，。,;；.\n（(]/)[0]?.trim() ?? "";
  const max = /[\u3400-\u9fff]/.test(first) ? 14 : 24;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** True when the mask's name already appeared in a scammer line (the decoy may know that much). */
export function nameSaid(name: string | undefined, turns: Pick<ArenaTurn, "side" | "text">[] = []): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  const lower = n.toLowerCase();
  return turns.some((t) => t.side === "scammer" && typeof t.text === "string" && t.text.toLowerCase().includes(lower));
}

/* ───────────── scammer line + sheet ───────────── */

/**
 * One line above the chat: 「骗子：许曼宁（面具）· 真人：阿杰 · 园区」, tap opens the two-part card.
 * When the human plays the decoy (`allowed` false) it shows at most the name the scammer has already said.
 */
export function ScammerLine({ scammer, allowed, turns }: { scammer?: ArenaSession["scammer"]; allowed: boolean; turns?: ArenaTurn[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const card = scammer?.card;
  const cover = scammer?.cover;
  if (!card && !cover) return null;
  if (!allowed) {
    if (!cover?.name || !nameSaid(cover.name, turns)) return null;
    return (
      <div className="persona-line scammer-line static" data-testid="scammer-line-public">
        <span className="persona-line-label">{t("smind.saidName")}</span>
        <span className="persona-line-text">{cover.name}</span>
      </div>
    );
  }
  const parts = [
    cover?.name ? t("smind.maskName", { name: cover.name }) : null,
    card?.handle ? t("smind.realName", { name: card.handle }) : null,
    situationTag(card?.situation) || null,
  ].filter(Boolean);
  return (
    <>
      <button type="button" className="persona-line scammer-line" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="persona-line-label">{t("smind.line")}</span>
        <span className="persona-line-text">{parts.join(" · ")}</span>
        <span className="persona-line-more" aria-hidden>
          {t("smind.open")} ›
        </span>
      </button>
      {open && <ScammerSheet scammer={{ card: card as ScammerCard, cover }} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ScammerSheet({ scammer, onClose }: { scammer: Partial<Scammer>; onClose: () => void }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const c: Partial<ScriptCover> = scammer.cover ?? {};
  const k: Partial<ScammerCard> = scammer.card ?? {};
  const title = c.name || k.handle || t("smind.title");
  return (
    <div className="dialog-backdrop sheet-backdrop" onClick={onClose}>
      <div className="card persona-sheet scammer-sheet" role="dialog" aria-modal="true" aria-labelledby="scammer-title" onClick={(e) => e.stopPropagation()}>
        <div className="persona-sheet-head">
          <div>
            <div className="eyebrow">{t("smind.title")}</div>
            <h2 id="scammer-title">{title}</h2>
          </div>
          <button ref={closeRef} type="button" className="btn small" onClick={onClose}>
            {t("training.collapse")}
          </button>
        </div>
        <p className="muted small">{t("smind.hint")}</p>

        {scammer.cover && (
          <section className="sheet-part" aria-label={t("smind.cover")}>
            <h3>{t("smind.cover")}</h3>
            <p className="muted small">{t("smind.coverHint")}</p>
            <Field label={t("smind.c.who")}>{[c.name, c.age, c.job, c.location].filter((x) => x !== undefined && x !== null && String(x).trim() !== "").join(" · ")}</Field>
            <Field label={t("smind.c.backstory")}>{c.backstory}</Field>
            <Field label={t("smind.c.people")}>{bullet(c.people)}</Field>
            <Field label={t("smind.c.props")}>{bullet(c.props)}</Field>
            <Field label={t("smind.c.cannotDo")}>{bullet(c.cannotDo)}</Field>
          </section>
        )}

        {scammer.card && (
          <section className="sheet-part" aria-label={t("smind.card")}>
            <h3>{t("smind.card")}</h3>
            <p className="muted small">{t("smind.cardHint")}</p>
            <Field label={t("smind.k.who")}>{[k.handle, k.age].filter((x) => x !== undefined && x !== null && String(x).trim() !== "").join(" · ")}</Field>
            <Field label={t("smind.k.situation")}>{k.situation}</Field>
            <Field label={t("smind.k.pressure")}>{k.pressure}</Field>
            <Field label={t("smind.k.discipline")}>{k.scriptDiscipline}</Field>
            <Field label={t("smind.k.slips")}>{bullet(k.slips)}</Field>
            <Field label={t("smind.k.triggers")}>{bullet(k.suspicionTriggers)}</Field>
            <Field label={t("smind.k.tests")}>{bullet(k.tests)}</Field>
            <Field label={t("smind.k.onSuspicion")}>{bullet(k.onSuspicion)}</Field>
            <Field label={t("smind.k.limits")}>{bullet(k.limits)}</Field>
            <Field label={t("mind.p.voice")}>
              {(k.voice?.style || arr(k.voice?.catchphrases).length > 0 || arr(k.voice?.quirks).length > 0) && (
                <>
                  {k.voice?.style && <p>{k.voice.style}</p>}
                  {arr(k.voice?.catchphrases).length > 0 && (
                    <p>
                      <span className="muted small">{t("mind.p.catchphrases")}</span> {arr(k.voice?.catchphrases).map((x) => `「${x}」`).join(" ")}
                    </p>
                  )}
                  {bullet(k.voice?.quirks)}
                </>
              )}
            </Field>
          </section>
        )}
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

/* ───────────── per-line hidden note ───────────── */

export const hasScammerTurnMind = (m?: ScammerTurnMind) => !!m && !!(m.think?.trim() || m.plan?.trim() || typeof m.baitSuspicion === "number" || m.action);

export const scoreTone = (score: number) => (score >= 60 ? "high" : score >= 30 ? "mid" : "low");

export function ActionBadge({ action }: { action: ScammerAction }) {
  const { tl } = useI18n();
  return <span className={`mini-chip saction ${action}`}>{tl("saction", action)}</span>;
}

export function ScammerTurnMindChip({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return <TurnMindChip open={open} onToggle={onToggle} title={t("smind.turnHint")} />;
}

export function ScammerTurnMindNote({ mind }: { mind: ScammerTurnMind }) {
  const { t } = useI18n();
  const score = typeof mind.baitSuspicion === "number" ? Math.round(mind.baitSuspicion) : null;
  return (
    <div className="aside-note mind-note smind-note">
      {(score !== null || mind.action) && (
        <div className="row gap-s">
          {score !== null && (
            <span>
              <b>{t("smind.suspicion")}</b> <span className={`mind-score ${scoreTone(score)}`}>{t("mind.score", { score })}</span>
            </span>
          )}
          {mind.action && <ActionBadge action={mind.action} />}
        </div>
      )}
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
    </div>
  );
}

/* ───────────── running state card ───────────── */

/** Small "scammer mind" panel. Folded by default on phones (`defaultOpen` overrides). */
export function ScammerMindCard({ mind, defaultOpen }: { mind?: ScammerMind; defaultOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => defaultOpen ?? !isPhone());
  if (!mind) return null;
  const raw = mind.baitSuspicion?.score;
  const score = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  const signals = arr(mind.baitSuspicion?.signals);
  const facts = arr(mind.facts);
  const actions = arr(mind.actions);
  return (
    <details className="mind-card smind-card" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <strong>{t("smind.mindCard")}</strong>
        <span className="muted small">
          {score === null ? t("smind.noScore") : t("smind.summary", { score })}
          {actions.length > 0 && ` · ${t("smind.actionsShort", { n: actions.length })}`}
        </span>
      </summary>
      <div className="mind-body">
        <div className="smind-meter-row">
          <span className="small">{t("smind.suspicionLong")}</span>
          {score === null ? (
            <span className="muted small">—</span>
          ) : (
            <span className={`mind-score ${scoreTone(score)}`}>{t("mind.score", { score })}</span>
          )}
        </div>
        {score !== null && (
          <div className="smind-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label={t("smind.suspicionLong")}>
            <span className={`smind-fill ${scoreTone(score)}`} style={{ width: `${score}%` }} />
            <i className="smind-tick" style={{ left: "60%" }} title="60" aria-hidden />
            <i className="smind-tick" style={{ left: "80%" }} title="80" aria-hidden />
          </div>
        )}
        <p className="muted small smind-legend">{t("smind.legend")}</p>
        {signals.length > 0 && (
          <div className="tag-pick">
            {signals.map((s) => (
              <span key={s} className="tag static">
                {s}
              </span>
            ))}
          </div>
        )}
        {mind.plan?.trim() && (
          <p className="small mind-plan">
            <b>{t("mind.planNow")}</b> {mind.plan}
          </p>
        )}

        <details className="mind-sub">
          <summary>{t("smind.facts", { n: facts.length })}</summary>
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

        <h4>{t("smind.actions")}</h4>
        {actions.length === 0 ? (
          <p className="muted small">{t("smind.noActions")}</p>
        ) : (
          <ul className="mind-list smind-actions">
            {actions.map((a, i) => (
              <li key={i}>
                <span className="turn-idx muted">#{a.turn}</span> <ActionBadge action={a.action} />
                {a.detail && <span className="small"> {a.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * Replay: only what the scammer knew up to the last line on screen. The suspicion score follows the last
 * replayed line's own note when there is one (the final score would spoil the ending).
 */
export function scammerMindUpTo(m: ScammerMind | undefined, turns: ArenaTurn[]): ScammerMind | undefined {
  if (!m) return m;
  const last = turns.length ? turns[turns.length - 1].index : -1;
  const lastNote = [...turns].reverse().find((x) => x.side === "scammer" && typeof x.scammerMind?.baitSuspicion === "number");
  return {
    ...m,
    facts: arr(m.facts).filter((f) => f.turn <= last),
    actions: arr(m.actions).filter((a) => a.turn <= last),
    baitSuspicion: lastNote ? { score: lastNote.scammerMind!.baitSuspicion!, signals: arr(m.baitSuspicion?.signals) } : last < 0 ? { score: 0, signals: [] } : m.baitSuspicion,
  };
}
