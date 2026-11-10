import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Me } from "@baitnet/shared";
import { closedTour, markTourDone, placeBubble, shouldAutoStart, spotlight, tourDone, tourKey, tourReducer, waitForTarget, type TourState } from "./machine";
import { enterStep, onRoute, stepsFor, type StepEnv } from "./steps";
import { TourDemo, TourOverlay } from "./Tour";
import { I18nProvider, type UiLang } from "../i18n";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { AuthProvider } from "../auth/context";
import { GuideView, GUIDE_SECTIONS } from "../pages/GuidePage";
import { compactNav, NavTabs, UserChip } from "../App";

/** In-memory localStorage (node test env has none). */
function fakeStorage(throwing = false) {
  const m = new Map<string, string>();
  const boom = () => {
    throw new Error("blocked");
  };
  return {
    getItem: (k: string) => (throwing ? boom() : (m.get(k) ?? null)),
    setItem: (k: string, v: string) => (throwing ? boom() : void m.set(k, v)),
    removeItem: (k: string) => (throwing ? boom() : void m.delete(k)),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}
const g = globalThis as { localStorage?: Storage };
let saved: Storage | undefined;
beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = fakeStorage();
});
afterEach(() => {
  g.localStorage = saved;
});

describe("tour state machine", () => {
  const open = (index: number, total = 9): TourState => ({ open: true, index, total });
  it("start / next / prev / go / skip", () => {
    let s = tourReducer(closedTour, { type: "start", total: 9 });
    expect(s).toEqual(open(0));
    s = tourReducer(s, { type: "prev" });
    expect(s).toEqual(open(0)); // prev on the first step stays
    s = tourReducer(tourReducer(s, { type: "next" }), { type: "next" });
    expect(s).toEqual(open(2));
    s = tourReducer(s, { type: "prev" });
    expect(s).toEqual(open(1));
    expect(tourReducer(s, { type: "go", index: 7 })).toEqual(open(7));
    expect(tourReducer(s, { type: "go", index: 99 })).toEqual(open(1));
    expect(tourReducer(s, { type: "skip" })).toEqual(closedTour);
  });
  it("next on the last step finishes; actions on a closed tour do nothing; replay restarts at step 1", () => {
    expect(tourReducer(open(8), { type: "next" })).toEqual(closedTour);
    expect(tourReducer(closedTour, { type: "next" })).toEqual(closedTour);
    expect(tourReducer(closedTour, { type: "start", total: 0 })).toEqual(closedTour);
    expect(tourReducer(open(5), { type: "start", total: 11 })).toEqual(open(0, 11));
  });
});

describe("auto-start: once per user, live + logged in only", () => {
  it("per-user key, done after finish/skip, never again; replay is still possible", () => {
    expect(tourKey("u-zhou")).toBe("baitnet.tour.v1.u-zhou");
    expect(shouldAutoStart({ userId: "u-zhou", live: true, done: tourDone("u-zhou") })).toBe(true);
    markTourDone("u-zhou");
    expect(localStorage.getItem("baitnet.tour.v1.u-zhou")).toBe("done");
    expect(shouldAutoStart({ userId: "u-zhou", live: true, done: tourDone("u-zhou") })).toBe(false);
    // another user on the same device still gets it
    expect(shouldAutoStart({ userId: "u-mia", live: true, done: tourDone("u-mia") })).toBe(true);
    // replay ignores the flag: the reducer starts regardless
    expect(tourReducer(closedTour, { type: "start", total: 9 })).toMatchObject({ open: true, index: 0 });
  });
  it("logged out, snapshot / local mode: no auto-start", () => {
    expect(shouldAutoStart({ userId: null, live: true, done: false })).toBe(false);
    expect(shouldAutoStart({ userId: "u-zhou", live: false, done: false })).toBe(false);
  });
  it("blocked storage never throws (and then counts as not done)", () => {
    g.localStorage = fakeStorage(true);
    expect(() => markTourDone("u-x")).not.toThrow();
    expect(tourDone("u-x")).toBe(false);
  });
});

describe("steps", () => {
  it("expert: 9 steps in order; reviewer: + pending review + team before the last", () => {
    const e = stepsFor("expert").map((s) => s.id);
    expect(e).toEqual(["welcome", "scripts", "modes", "model", "start", "input", "rate", "upload", "account"]);
    const r = stepsFor("reviewer").map((s) => s.id);
    expect(r).toEqual([...e.slice(0, -1), "review", "team", "account"]);
  });
  it("every step's text exists in both languages", () => {
    for (const s of stepsFor("reviewer"))
      for (const k of [s.title, s.body, s.fallback].filter(Boolean) as (keyof typeof en)[]) {
        expect(en[k], k).toBeTruthy();
        expect(zh[k], k).toBeTruthy();
      }
  });
  it("onRoute: empty hash is the arena; training sub-pages must match", () => {
    const [welcome, , , , , , , upload, account] = stepsFor("expert");
    expect(onRoute(welcome!, [])).toBe(true);
    expect(onRoute(upload!, ["training"])).toBe(false);
    expect(onRoute(upload!, ["training", "upload"])).toBe(true);
    expect(onRoute(account!, ["team"])).toBe(true); // no route: stays wherever it is
  });
});

describe("cross-page steps and missing targets", () => {
  /** A fake page: elements per route. */
  function env(dom: Record<string, string[]>, start = "#/arena") {
    let hash = start;
    const log: string[] = [];
    const e: StepEnv<string> = {
      getHash: () => hash,
      setHash: (h) => {
        log.push(h);
        hash = h;
      },
      query: (sel) => {
        const page = hash.replace(/^#\//, "") || "arena";
        const id = /data-tour="([^"]+)"/.exec(sel)![1]!;
        return (dom[page] ?? []).includes(id) ? id : null;
      },
      wait: (q, ms) => waitForTarget(q, ms, { intervalMs: 1, sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 50); })() }),
    };
    return { e, log, hash: () => hash };
  }
  const dom = {
    arena: ["arena-scripts", "arena-modes", "arena-model", "arena-start"],
    "training/upload": ["training-upload"],
    "training/review": ["training-review"],
    team: ["team-invite"],
  };

  it("walks the reviewer tour: switches pages itself, finds each element, falls back where the session is not open", async () => {
    const { e, log } = env(dom, "#/guide");
    const found: Record<string, string | null> = {};
    for (const s of stepsFor("reviewer")) found[s.id] = (await enterStep(s, e)).target;
    expect(log).toEqual(["#/arena", "#/training/upload", "#/training/review", "#/team"]);
    expect(found).toMatchObject({ scripts: "arena-scripts", modes: "arena-modes", model: "arena-model", start: "arena-start", upload: "training-upload", review: "training-review", team: "team-invite" });
    // no session open: no send box / rating row -> null = centred bubble with the demo card
    expect(found.input).toBeNull();
    expect(found.rate).toBeNull();
    // the user chip lives in the top bar (not in this fake page) -> also degrades instead of hanging
    expect(found.account).toBeNull();
  });

  it("going back re-opens the previous page", async () => {
    const { e, hash } = env(dom, "#/training/upload");
    await enterStep(stepsFor("expert")[6]!, e);
    expect(hash()).toBe("#/arena");
  });

  it("waitForTarget: finds a late element, times out to null, stops when cancelled", async () => {
    let n = 0;
    const fast = { intervalMs: 1, sleep: async () => undefined };
    let clock = 0;
    expect(await waitForTarget(() => (++n >= 3 ? "el" : null), 1000, { ...fast, now: () => (clock += 10) })).toBe("el");
    clock = 0;
    expect(await waitForTarget(() => null, 100, { ...fast, now: () => (clock += 10) })).toBeNull();
    expect(await waitForTarget(() => "el", 100, { ...fast, cancelled: () => true })).toBeNull();
  });
});

describe("bubble placement stays on screen", () => {
  const vp = { width: 1280, height: 800 };
  const b = { width: 380, height: 200 };
  const inside = (p: ReturnType<typeof placeBubble>, v = vp) =>
    p.kind === "float" && p.top >= 0 && p.left >= 0 && p.top + b.height <= v.height && p.left + b.width <= v.width;
  it("no target: centred", () => expect(placeBubble(null, b, vp, false)).toEqual({ kind: "center" }));
  it("desktop: below, else above, else pinned; clamped horizontally", () => {
    const below = placeBubble({ top: 100, left: 1200, width: 60, height: 40 }, b, vp, false);
    expect(below).toMatchObject({ kind: "float", side: "below" });
    expect(inside(below)).toBe(true);
    const above = placeBubble({ top: 700, left: 0, width: 60, height: 40 }, b, vp, false);
    expect(above).toMatchObject({ kind: "float", side: "above" });
    expect(inside(above)).toBe(true);
    const tall = placeBubble({ top: 20, left: 20, width: 680, height: 760 }, b, vp, false);
    expect(tall).toMatchObject({ kind: "float", side: "right", left: 712 });
    expect(inside(tall)).toBe(true);
    const tallRight = placeBubble({ top: 20, left: 600, width: 660, height: 760 }, b, vp, false);
    expect(tallRight).toMatchObject({ kind: "float", side: "left" });
    expect(inside(tallRight)).toBe(true);
    const full = placeBubble({ top: 20, left: 100, width: 1080, height: 760 }, b, vp, false);
    expect(full).toMatchObject({ kind: "float", side: "over" });
    expect(inside(full)).toBe(true);
  });
  it("phone: docks to the edge away from the target", () => {
    const phone = { width: 375, height: 812 };
    expect(placeBubble({ top: 60, left: 16, width: 340, height: 200 }, b, phone, true)).toEqual({ kind: "dock", edge: "bottom" });
    expect(placeBubble({ top: 600, left: 16, width: 340, height: 60 }, b, phone, true)).toEqual({ kind: "dock", edge: "top" });
  });
  it("spotlight is clipped to the screen", () => {
    expect(spotlight({ top: -50, left: 10, width: 100, height: 2000 }, vp)).toEqual({ top: 0, left: 4, width: 112, height: 800 });
  });
});

const wrap = (lang: UiLang, node: ReactElement) => renderToStaticMarkup(<I18nProvider lang={lang}>{node}</I18nProvider>);

describe("tour bubble markup", () => {
  const steps = stepsFor("expert");
  const noop = () => undefined;
  it("is an accessible dialog with progress and Skip / Back / Next", () => {
    const html = wrap("zh", <TourOverlay step={steps[2]!} index={2} total={9} onNext={noop} onPrev={noop} onSkip={noop} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="tour-title"');
    expect(html).toContain("3 / 9");
    expect(html).toContain("第 3 步，共 9 步");
    for (const s of ["跳过", "上一步", "下一步", "两边谁来演"]) expect(html).toContain(s);
  });
  it("first step: Back disabled; last step: Done", () => {
    const first = wrap("en", <TourOverlay step={steps[0]!} index={0} total={9} onNext={noop} onPrev={noop} onSkip={noop} />);
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>Back<\/button>/);
    const last = wrap("en", <TourOverlay step={steps[8]!} index={8} total={9} onNext={noop} onPrev={noop} onSkip={noop} />);
    expect(last).toContain(">Done</button>");
  });
  it("demo cards stand in for a session that is not open yet", () => {
    expect(wrap("zh", <TourDemo kind="rate" />)).toContain("转到哪个地址？波场还是以太坊链？");
    const input = wrap("en", <TourDemo kind="input" />);
    expect(input).toContain("Send");
    expect(input).toContain("Decoy is typing");
  });
});

describe("guide page", () => {
  it("renders every section in Chinese, with the replay button and the bad/good example", () => {
    const html = wrap("zh", <GuideView role="expert" />);
    expect(html).toContain("重新带我走一遍");
    for (const id of GUIDE_SECTIONS) expect(html).toContain(zh[`guide.s.${id}`]);
    expect(html).toContain("转到哪个地址？波场还是以太坊链？");
    expect(html).toContain("啊？你人没事吧？！伤到哪了？警察怎么说的，要妈帮你做什么？");
    expect(html).toContain("零留存不支持截图");
    for (const m of ["DeepSeek", "GLM", "Claude Haiku", "Claude Sonnet"]) expect(html).toContain(m);
    expect(html).toContain("这一章给审核者看"); // experts see the reviewer chapter labelled, collapsed
    expect(html).not.toMatch(/<details[^>]*id="guide-reviewer"[^>]*open/);
  });
  it("renders in English; reviewers get their chapter open", () => {
    const html = wrap("en", <GuideView role="reviewer" />);
    expect(html).toContain("Walk me through it again");
    for (const id of GUIDE_SECTIONS) expect(html).toContain(en[`guide.s.${id}`]);
    expect(html).toMatch(/<details[^>]*id="guide-reviewer"[^>]*open/);
  });
  it("logged out: readable, but the tour button asks to log in", () => {
    const html = wrap("zh", <GuideView role={null} />);
    expect(html).toContain("请先用邀请链接登录");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>▶ 重新带我走一遍/);
  });
});

describe("entry points", () => {
  const me: Me = { authEnabled: true, expertId: "u-zhou", name: "老周", role: "expert", llmQuota: { usedToday: 3, limitPerDay: 100 } };
  it("phone: under More; desktop: in the back-office group next to Sessions", () => {
    expect(compactNav("expert", true)!.more[0]).toBe("guide");
    expect(compactNav("reviewer", true)!.more[0]).toBe("guide");
    const html = wrap("zh", <AuthProvider apiBase={null} ready initialState={{ kind: "anonymous" }}><NavTabs tab="arena" /></AuthProvider>);
    expect(html).toMatch(/href="#\/sessions"[\s\S]*href="#\/guide"/);
    expect(html).toContain("使用教学");
  });
  it("user menu: guide link, replay button, and the tour anchor on the chip", () => {
    const html = wrap("zh", <AuthProvider apiBase={null} ready initialState={{ kind: "user", me }}><UserChip /></AuthProvider>);
    expect(html).toContain('href="#/guide"');
    expect(html).toContain("重新带我走一遍");
    expect(html).toContain('data-tour="user-chip"');
  });
});
