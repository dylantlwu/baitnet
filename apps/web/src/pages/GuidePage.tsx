import { ARENA_MODELS, DEFAULT_ARENA_MODEL, type Role } from "@baitnet/shared";
import type { ReactNode } from "react";
import { useAuth } from "../auth/context";
import { useI18n, type MsgKey } from "../i18n";
import { isTouchOnly, useTour } from "../tour/Tour";
import { Badge, PageHead } from "../components/ui";

/** D31: the in-app manual. Works logged out too; only the tour button needs a login. */
export const GUIDE_SECTIONS = ["intro", "login", "practice", "teach", "upload", "models", "reviewer", "faq", "cheat"] as const;
type SectionId = (typeof GUIDE_SECTIONS)[number];

/** "a\nb" -> list items */
const lines = (s: string) => s.split("\n").filter((x) => x.trim());

export function GuidePage() {
  const { state } = useAuth();
  const role: Role | null = state?.kind === "user" ? state.me.role : null;
  return <GuideView role={role} />;
}

/** Pure view (tests render it without auth / tour providers). */
export function GuideView({ role }: { role: Role | null }) {
  const { t } = useI18n();
  const tour = useTour();
  const jump = (id: SectionId) => {
    const el = document.getElementById(`guide-${id}`);
    if (!el) return;
    if (el instanceof HTMLDetailsElement) el.open = true;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const body: Record<SectionId, ReactNode> = {
    intro: (
      <>
        <p>{t("guide.intro.p1")}</p>
        <p>{t("guide.intro.p2")}</p>
        <p className="muted">{t("guide.intro.p3")}</p>
      </>
    ),
    login: <List k="guide.login.steps" ordered />,
    practice: (
      <>
        <p>{t("guide.practice.p1")}</p>
        <div className="guide-ways">
          {(["way1", "way2", "way3", "whisper"] as const).map((w) => (
            <div key={w} className="guide-way">
              <strong>{t(`guide.practice.${w}.t`)}</strong>
              <p>{t(`guide.practice.${w}.b`)}</p>
            </div>
          ))}
        </div>
        <p className="muted">{t("guide.practice.addresses")}</p>
      </>
    ),
    teach: (
      <>
        <p>{t("guide.teach.p1")}</p>
        <List k="guide.teach.list" />
        <h3>{t("guide.teach.exampleTitle")}</h3>
        <p className="guide-scene">{t("guide.teach.scene")}</p>
        <div className="guide-compare">
          <div className="guide-bad">
            <div className="small">✗ {t("guide.teach.badLabel")}</div>
            <blockquote>{t("guide.teach.badLine")}</blockquote>
            <p className="small">{t("guide.teach.badWhy")}</p>
          </div>
          <div className="guide-good">
            <div className="small">✓ {t("guide.teach.goodLabel")}</div>
            <blockquote>{t("guide.teach.goodLine")}</blockquote>
            <p className="small">{t("guide.teach.goodWhy")}</p>
          </div>
        </div>
      </>
    ),
    upload: (
      <>
        <p>{t("guide.upload.p1")}</p>
        <List k="guide.upload.rules" className="guide-rules" />
      </>
    ),
    models: (
      <>
        <p>{t("guide.models.p1")}</p>
        <table className="table guide-models">
          <thead>
            <tr>
              <th>{t("guide.models.col.model")}</th>
              <th>{t("guide.models.col.tee")}</th>
              <th>{t("guide.models.col.use")}</th>
            </tr>
          </thead>
          <tbody>
            {ARENA_MODELS.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.label}</strong>
                  {m.id === DEFAULT_ARENA_MODEL && <span className="muted small"> · {t("arena.modelDefault")}</span>}
                </td>
                <td>
                  <Badge tone={m.tee ? "ok" : "muted"}>{t(m.tee ? "arena.modelTee" : "arena.modelNoTee")}</Badge>
                </td>
                <td className="small">{t(`guide.models.${m.id}` as MsgKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note warn-note small">{t("guide.models.note")}</p>
      </>
    ),
    reviewer: (
      <>
        {role !== "reviewer" && <p className="muted small">{t("guide.reviewerNote")}</p>}
        <List k="guide.reviewer.list" />
      </>
    ),
    faq: (
      <dl className="guide-faq">
        {([1, 2, 3, 4, 5, 6] as const).map((i) => (
          <div key={i}>
            <dt>{t(`guide.faq.q${i}`)}</dt>
            <dd>{t(`guide.faq.a${i}`)}</dd>
          </div>
        ))}
      </dl>
    ),
    cheat: <List k="guide.cheat.list" className="guide-cheat" />,
  };

  return (
    <div className="guide" data-tour="guide">
      <PageHead step={t("nav.guide")} title={t("guide.title")} lead={t("guide.lead")} />
      <div className="card guide-replay">
        {role ? (
          <>
            <button type="button" className="btn primary guide-replay-btn" onClick={tour.start}>
              ▶ {t("guide.replay")}
            </button>
            <span className="muted small">
              {t("guide.replayHint")}
              {!isTouchOnly() && ` ${t("tour.keysHint")}`}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="btn primary guide-replay-btn" disabled>
              ▶ {t("guide.replay")}
            </button>
            <span className="muted small">{t("guide.replayNeedLogin")}</span>
          </>
        )}
      </div>
      <nav className="card guide-toc" aria-label={t("guide.toc")}>
        <strong className="small">{t("guide.toc")}</strong>
        <ol>
          {GUIDE_SECTIONS.map((id) => (
            <li key={id}>
              <button type="button" className="link-btn" onClick={() => jump(id)}>
                {t(`guide.s.${id}`)}
                {id === "reviewer" && <> · <span className="muted">{t("guide.reviewerOnly")}</span></>}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {GUIDE_SECTIONS.map((id, i) => (
        <details key={id} id={`guide-${id}`} className="card guide-sec" open={id !== "reviewer" || role === "reviewer" || undefined}>
          <summary>
            <span className="guide-n">{i + 1}</span>
            <h2>{t(`guide.s.${id}`)}</h2>
            {id === "reviewer" && <Badge tone="info">{t("guide.reviewerOnly")}</Badge>}
          </summary>
          <div className="guide-body">{body[id]}</div>
        </details>
      ))}
    </div>
  );
}

function List({ k, ordered, className }: { k: MsgKey; ordered?: boolean; className?: string }) {
  const { t } = useI18n();
  const items = lines(t(k)).map((x, i) => <li key={i}>{x}</li>);
  return ordered ? <ol className={className}>{items}</ol> : <ul className={className}>{items}</ul>;
}
