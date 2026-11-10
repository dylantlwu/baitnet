import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/context";
import { useI18n } from "../i18n";
import { closedTour, markTourDone, placeBubble, shouldAutoStart, spotlight, tourDone, tourReducer, waitForTarget, type Rect } from "./machine";
import { enterStep, onRoute, routeHash, stepsFor, type TourStep } from "./steps";
import { parseHash } from "../lib/router";

interface TourCtx {
  /** Start (or replay) the tour; no-op when nobody is logged in. */
  start: () => void;
  /** A logged-in user exists, so the tour can run. */
  canStart: boolean;
}
const Ctx = createContext<TourCtx>({ start: () => undefined, canStart: false });
export const useTour = () => useContext(Ctx);

/** Wraps the app inside AuthProvider. `live` = talking to the real backend (no auto-start in snapshot / local mode). */
export function TourProvider({ live, children }: { live: boolean; children: ReactNode }) {
  const { state } = useAuth();
  const me = state?.kind === "user" ? state.me : null;
  const userId = me?.expertId ?? null;
  const steps = useMemo(() => (me ? stepsFor(me.role) : []), [me?.role]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tour, dispatch] = useReducer(tourReducer, closedTour);
  const tried = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !live || tried.current === userId) return;
    tried.current = userId;
    if (shouldAutoStart({ userId, live, done: tourDone(userId) })) dispatch({ type: "start", total: steps.length });
  }, [userId, live, steps.length]);

  // logging out closes it
  useEffect(() => {
    if (!userId) dispatch({ type: "skip" });
  }, [userId]);

  const finish = useCallback(() => {
    if (userId) markTourDone(userId);
    dispatch({ type: "skip" });
    // the last steps live on other pages (upload, team): end where work starts, in the arena
    returnToArena({ getHash: () => window.location.hash, setHash: (h) => (window.location.hash = h) });
  }, [userId]);
  const next = useCallback(() => {
    if (tour.open && tour.index + 1 >= tour.total) finish();
    else dispatch({ type: "next" });
  }, [tour, finish]);
  const prev = useCallback(() => dispatch({ type: "prev" }), []);
  const start = useCallback(() => {
    if (userId) dispatch({ type: "start", total: steps.length });
  }, [userId, steps.length]);

  // give focus back to where it was once the tour closes
  const restore = useRef<Element | null>(null);
  useEffect(() => {
    if (tour.open) {
      restore.current ??= document.activeElement;
      return;
    }
    const el = restore.current;
    restore.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
  }, [tour.open]);

  const value = useMemo(() => ({ start, canStart: !!userId }), [start, userId]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {tour.open && steps[tour.index] && (
        <TourOverlay key={tour.index} step={steps[tour.index]} index={tour.index} total={tour.total} onNext={next} onPrev={prev} onSkip={finish} />
      )}
    </Ctx.Provider>
  );
}

/** After the tour (done or skipped): back to the arena unless already there. */
export function returnToArena(env: { getHash: () => string; setHash: (h: string) => void }): void {
  if (!onRoute({ route: "arena" } as TourStep, parseHash(env.getHash()).parts)) env.setHash(routeHash("arena"));
}

/** Phones / tablets: no keyboard, so no "Esc skips, ← → page through" hint. */
export function isTouchOnly(win: { matchMedia?: (q: string) => { matches: boolean } } | undefined = typeof window === "undefined" ? undefined : window): boolean {
  try {
    return !!win?.matchMedia && win.matchMedia("(pointer: coarse)").matches && !win.matchMedia("(any-pointer: fine)").matches;
  } catch {
    return false;
  }
}

const NARROW_PX = 640;
const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && Math.round(a.top) === Math.round(b.top) && Math.round(a.left) === Math.round(b.left) && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height));
const visible = (el: Element | null) => (el && el.getClientRects().length > 0 ? el : null);
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Bring the target on screen: phones put it near the top (the bubble docks below), desktops centre it. */
function scrollToTarget(el: Element) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
  if (window.innerWidth <= NARROW_PX) {
    if (r.top >= 56 && r.bottom <= vh * 0.55) return;
    window.scrollBy({ top: r.top - 64, behavior });
  } else {
    if (r.top >= 16 && r.bottom <= vh - 16) return;
    el.scrollIntoView({ block: r.height > vh * 0.6 ? "start" : "center", behavior });
  }
}

export function TourOverlay({ step, index, total, onNext, onPrev, onSkip }: { step: TourStep; index: number; total: number; onNext: () => void; onPrev: () => void; onSkip: () => void }) {
  const { t } = useI18n();
  const [searching, setSearching] = useState(!!step.target);
  const [target, setTarget] = useState<Element | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [vp, setVp] = useState(() => (typeof window === "undefined" ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight }));
  const [size, setSize] = useState({ width: 360, height: 200 });
  const bubbleRef = useRef<HTMLDivElement>(null);

  // switch page, then wait for the element (or give up and centre the bubble)
  useEffect(() => {
    let cancelled = false;
    void enterStep<Element>(step, {
      getHash: () => window.location.hash,
      setHash: (h) => {
        window.location.hash = h;
      },
      query: (sel) => visible(document.querySelector(sel)),
      wait: (q, ms) => waitForTarget(q, ms, { cancelled: () => cancelled }),
    }).then(({ target: el }) => {
      if (cancelled) return;
      setSearching(false);
      setTarget(el);
      if (el) scrollToTarget(el);
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // follow the element while the page scrolls / reflows
  useEffect(() => {
    if (!target) return setRect(null);
    let raf = 0;
    let last: Rect | null = null;
    const tick = () => {
      const r = target.isConnected ? target.getBoundingClientRect() : null;
      const cur = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
      if (!sameRect(cur, last)) setRect((last = cur));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target]);

  useEffect(() => {
    const on = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  useLayoutEffect(() => {
    const b = bubbleRef.current;
    if (!b) return;
    const s = { width: b.offsetWidth, height: b.offsetHeight };
    if (Math.abs(s.width - size.width) > 1 || Math.abs(s.height - size.height) > 1) setSize(s);
  });

  // keyboard: Esc skips, arrows page, Tab stays inside the bubble (the Next button gets focus on each step)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onSkip();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrev();
      } else if (e.key === "Tab" && bubbleRef.current) {
        const f = [...bubbleRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]!.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onPrev, onSkip]);

  const narrow = vp.width <= NARROW_PX;
  const shown = rect && rect.width > 0 && rect.height > 0 ? rect : null;
  const spot = shown ? spotlight(shown, vp) : null;
  const hasSpot = !!spot && spot.width > 0 && spot.height > 0;
  const place = placeBubble(hasSpot ? shown : null, size, vp, narrow);
  const missing = !!step.target && !searching && !target;
  const bodyKey = missing && step.fallback ? step.fallback : step.body;
  const last = index + 1 >= total;

  const style = place.kind === "float" ? { top: place.top, left: place.left } : undefined;
  const cls = place.kind === "center" ? "center" : place.kind === "dock" ? `dock-${place.edge}` : `float side-${place.side}`;

  return (
    <div className="tour-root">
      <div className="tour-block" aria-hidden onClick={(e) => e.stopPropagation()} />
      {hasSpot ? <div className="tour-spot" aria-hidden style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} /> : <div className="tour-dim" aria-hidden />}
      <div
        ref={bubbleRef}
        className={`tour-bubble ${cls}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        data-step={step.id}
        data-placement={place.kind === "dock" ? `dock-${place.edge}` : place.kind}
      >
        <div className="tour-progress" aria-label={t("tour.progressLabel", { n: index + 1, total })}>
          <span>{t("tour.progress", { n: index + 1, total })}</span>
          <span className="tour-dots" aria-hidden>
            {Array.from({ length: total }, (_, i) => (
              <i key={i} className={i === index ? "on" : i < index ? "done" : ""} />
            ))}
          </span>
        </div>
        <h2 id="tour-title">{t(step.title)}</h2>
        <p id="tour-body">
          {searching ? t("tour.finding") : t(bodyKey)}
          {index === 0 && !searching && !isTouchOnly() && <span className="tour-keys"> {t("tour.keysHint")}</span>}
        </p>
        {missing && step.demo && <TourDemo kind={step.demo} />}
        <div className="tour-actions">
          <button type="button" className="btn ghost small" onClick={onSkip}>
            {t("tour.skip")}
          </button>
          <span className="grow" />
          <button type="button" className="btn small" onClick={onPrev} disabled={index === 0}>
            {t("tour.prev")}
          </button>
          <button type="button" className="btn primary small" onClick={onNext} autoFocus>
            {last ? t("tour.done") : t("tour.next")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Stand-in for a session that has not started yet: what the send box / rating row will look like. */
export function TourDemo({ kind }: { kind: "input" | "rate" }) {
  const { t } = useI18n();
  if (kind === "input")
    return (
      <div className="tour-demo" aria-hidden>
        <div className="small">{t("arena.sayAs", { side: t("side.scammer") })}</div>
        <div className="tour-demo-input">{t("tour.demo.scammerLine")}</div>
        <div className="row gap-s">
          <span className="btn small primary">{t("arena.send")}</span>
        </div>
        <div className="tour-demo-typing small muted">… {t("arena.typing", { side: t("side.bait") })}</div>
      </div>
    );
  return (
    <div className="tour-demo" aria-hidden>
      <div className="tour-demo-bubble">{t("guide.teach.badLine")}</div>
      <div className="annot-row">
        <span className="rate rate-good">{t("rating.good")}</span>
        <span className="rate rate-bad on">{t("rating.bad")}</span>
        <span className="rate rate-risky">{t("rating.risky")}</span>
        <span className="rate rate-edit">✎ {t("training.rewriteShort")}</span>
      </div>
    </div>
  );
}
