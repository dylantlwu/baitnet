import { load, save } from "../lib/storage";

/** Tour state: closed, or open at step `index` of `total`. */
export type TourState = { open: false } | { open: true; index: number; total: number };
export type TourAction = { type: "start"; total: number } | { type: "next" } | { type: "prev" } | { type: "skip" } | { type: "go"; index: number };

export const closedTour: TourState = { open: false };

/** next on the last step finishes; prev on the first step stays; skip closes. */
export function tourReducer(s: TourState, a: TourAction): TourState {
  if (a.type === "start") return a.total > 0 ? { open: true, index: 0, total: a.total } : closedTour;
  if (!s.open) return s;
  switch (a.type) {
    case "next":
      return s.index + 1 >= s.total ? closedTour : { ...s, index: s.index + 1 };
    case "prev":
      return s.index === 0 ? s : { ...s, index: s.index - 1 };
    case "go":
      return a.index >= 0 && a.index < s.total ? { ...s, index: a.index } : s;
    case "skip":
      return closedTour;
  }
}

/** Per user, on this device: `baitnet.tour.v1.<userId>` = "done" once finished or skipped. */
export const tourKey = (userId: string) => `baitnet.tour.v1.${userId}`;
export const tourDone = (userId: string) => load(tourKey(userId)) === "done";
export const markTourDone = (userId: string) => save(tourKey(userId), "done");

/**
 * Auto-start only for a logged-in user on the live backend who has not finished / skipped it yet.
 * Logged out, auth off (local), snapshot replay and the in-browser mock never pop it up.
 */
export function shouldAutoStart(p: { userId: string | null; live: boolean; done: boolean }): boolean {
  return !!p.userId && p.live && !p.done;
}

/**
 * Poll for a step's element until it shows up or `timeoutMs` passes (then null: the caller shows the
 * bubble centred instead of hanging). `query` / `sleep` are injectable for tests.
 */
export async function waitForTarget<T>(
  query: () => T | null,
  timeoutMs: number,
  opts: { intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; cancelled?: () => boolean } = {},
): Promise<T | null> {
  const interval = opts.intervalMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const end = now() + timeoutMs;
  for (;;) {
    if (opts.cancelled?.()) return null;
    const el = query();
    if (el) return el;
    if (now() >= end) return null;
    await sleep(interval);
  }
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
export type Placement = { kind: "center" } | { kind: "dock"; edge: "top" | "bottom" } | { kind: "float"; top: number; left: number; side: "below" | "above" | "right" | "left" | "over" };

/**
 * Where the bubble goes.
 * - no target: centred.
 * - phone (narrow): docked to the screen edge away from where the target starts (CSS adds the safe-area insets).
 * - desktop: below the target if it fits, else above, else beside it, else pinned inside the screen; always clamped on screen.
 */
export function placeBubble(target: Rect | null, bubble: { width: number; height: number }, vp: { width: number; height: number }, narrow: boolean, gap = 12, margin = 12): Placement {
  if (!target) return { kind: "center" };
  if (narrow) {
    // the target's top is what matters (tall lists start there): it starts in the upper half -> dock below
    return { kind: "dock", edge: target.top < vp.height / 2 ? "bottom" : "top" };
  }
  const clampX = (x: number) => Math.max(margin, Math.min(x, vp.width - bubble.width - margin));
  const clampY = (y: number) => Math.max(margin, Math.min(y, vp.height - bubble.height - margin));
  const left = clampX(target.left + target.width / 2 - bubble.width / 2);
  const below = target.top + target.height + gap;
  if (below + bubble.height + margin <= vp.height) return { kind: "float", top: below, left, side: "below" };
  const above = target.top - gap - bubble.height;
  if (above >= margin) return { kind: "float", top: above, left, side: "above" };
  // tall target (a long list): beside it, so the whole thing stays visible
  const top = clampY(target.top);
  if (target.left + target.width + gap + bubble.width + margin <= vp.width) return { kind: "float", top, left: target.left + target.width + gap, side: "right" };
  if (target.left - gap - bubble.width >= margin) return { kind: "float", top, left: target.left - gap - bubble.width, side: "left" };
  return { kind: "float", top: clampY(vp.height - bubble.height - margin), left, side: "over" };
}

/** Highlight box: the target padded a little, clipped to the screen. */
export function spotlight(target: Rect, vp: { width: number; height: number }, pad = 6): Rect {
  const top = Math.max(0, target.top - pad);
  const left = Math.max(0, target.left - pad);
  const bottom = Math.min(vp.height, target.top + target.height + pad);
  const right = Math.min(vp.width, target.left + target.width + pad);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
