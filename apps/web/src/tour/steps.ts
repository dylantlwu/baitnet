import type { Role } from "@baitnet/shared";
import type { MsgKey } from "../i18n";
import { parseHash } from "../lib/router";

/**
 * D31 onboarding tour. Each step highlights a real element marked `data-tour="<target>"`.
 * `route` = hash path the step lives on (the tour switches pages by itself); no route = stay where you are.
 * `demo` = what to show in the bubble when the real element is not on screen (e.g. no session started yet).
 * `waitMs` = how long to wait for the element before falling back to a centred bubble.
 */
export interface TourStep {
  id: string;
  target?: string;
  route?: string;
  title: MsgKey;
  body: MsgKey;
  /** Shown instead of `body` when the target never appeared. */
  fallback?: MsgKey;
  demo?: "input" | "rate";
  waitMs?: number;
}

/** Default wait for a step's element (page switch + data load). */
export const TARGET_WAIT_MS = 4000;
/** Session-only elements are either there right away or not at all: short wait, then the demo card. */
const OPTIONAL_WAIT_MS = 700;

const EXPERT_HEAD: TourStep[] = [
  { id: "welcome", route: "arena", title: "tour.welcome.title", body: "tour.welcome.body" },
  { id: "scripts", target: "arena-scripts", route: "arena", title: "tour.scripts.title", body: "tour.scripts.body", fallback: "tour.arenaBusy" },
  { id: "modes", target: "arena-modes", route: "arena", title: "tour.modes.title", body: "tour.modes.body", fallback: "tour.arenaBusy" },
  { id: "model", target: "arena-model", route: "arena", title: "tour.model.title", body: "tour.model.body", fallback: "tour.arenaBusy" },
  { id: "start", target: "arena-start", route: "arena", title: "tour.start.title", body: "tour.start.body", fallback: "tour.arenaBusy" },
  {
    id: "input", target: "arena-input", route: "arena", title: "tour.input.title", body: "tour.input.body", fallback: "tour.input.demo", demo: "input", waitMs: OPTIONAL_WAIT_MS,
  },
  {
    id: "rate", target: "arena-rate", route: "arena", title: "tour.rate.title", body: "tour.rate.body", fallback: "tour.rate.demo", demo: "rate", waitMs: OPTIONAL_WAIT_MS,
  },
  { id: "upload", target: "training-upload", route: "training/upload", title: "tour.upload.title", body: "tour.upload.body" },
];
const REVIEWER_EXTRA: TourStep[] = [
  { id: "review", target: "training-review", route: "training/review", title: "tour.review.title", body: "tour.review.body" },
  { id: "team", target: "team-invite", route: "team", title: "tour.team.title", body: "tour.team.body" },
];
const TAIL: TourStep[] = [{ id: "account", target: "user-chip", title: "tour.account.title", body: "tour.account.body" }];

/** Experts: 9 steps. Reviewers: the same plus "pending review" and "team invites" before the last one. */
export function stepsFor(role: Role): TourStep[] {
  return role === "reviewer" ? [...EXPERT_HEAD, ...REVIEWER_EXTRA, ...TAIL] : [...EXPERT_HEAD, ...TAIL];
}

/** Does the current hash path already show this step's page? ("" counts as the arena: it is the default tab). */
export function onRoute(step: TourStep, hashParts: string[]): boolean {
  if (!step.route) return true;
  const want = step.route.split("/");
  const have = hashParts.length ? hashParts : ["arena"];
  return want.every((p, i) => have[i] === p);
}

export const routeHash = (route: string) => "#/" + route;

export interface StepEnv<T> {
  getHash: () => string;
  setHash: (h: string) => void;
  /** Find the step's element (null when absent / hidden). */
  query: (selector: string) => T | null;
  wait: (query: () => T | null, timeoutMs: number) => Promise<T | null>;
}

/**
 * Enter a step: switch to its page when needed, then wait for its element.
 * Resolves `target: null` when the element never showed up (the bubble is then centred with the fallback text).
 */
export async function enterStep<T>(step: TourStep, env: StepEnv<T>): Promise<{ navigated: boolean; target: T | null }> {
  let navigated = false;
  if (step.route && !onRoute(step, parseHash(env.getHash()).parts)) {
    env.setHash(routeHash(step.route));
    navigated = true;
  }
  if (!step.target) return { navigated, target: null };
  const sel = `[data-tour="${step.target}"]`;
  return { navigated, target: await env.wait(() => env.query(sel), step.waitMs ?? TARGET_WAIT_MS) };
}
