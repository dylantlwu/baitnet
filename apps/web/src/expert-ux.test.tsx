import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArenaSession, ArenaTurn, Correction, ScamScriptDef } from "@baitnet/shared";
import { compactNav, visibleSampleSections } from "./App";
import { AnnotateBar, defaultTrainingMode } from "./pages/ArenaPage";
import { afterLogin, landingFor, pendingWork } from "./pages/LoginPage";
import { applyEvent, arenaReducer, initialArena } from "./arena/reducer";
import { createMockBackend } from "./backend/mock";
import type { Backend } from "./backend/types";
import { pastedUpload } from "./scriptlab/analyze";
import { I18nProvider } from "./i18n";

const session: ArenaSession = {
  id: "s1", scriptId: "x", engine: "rules", modes: { scammer: "human", bait: "ai" }, status: "paused", turns: [], drafts: [], createdAt: "t",
};
const turn = (index: number, side: "scammer" | "bait", author: "ai" | "human" = "ai"): ArenaTurn => ({ index, side, text: `line ${index}`, author, ts: "t" });
const corr = (review: Correction["review"]) => ({ review }) as Correction;
const sess = (reviews: string[]) => ({ drafts: reviews.map((review) => ({ review })) }) as unknown as ArenaSession;

describe("1. typing indicator (reducer)", () => {
  const start = arenaReducer(initialArena, { type: "session", session });
  it("typing on/off follows the stream; the AI turn clears it even if 'off' is lost", () => {
    let st = applyEvent(start, { type: "typing", sessionId: "s1", side: "bait", on: true });
    expect(st.typing).toBe("bait");
    st = applyEvent(st, { type: "turn", sessionId: "s1", turn: turn(0, "scammer", "human") });
    expect(st.typing).toBe("bait"); // the human line does not clear it
    st = applyEvent(st, { type: "turn", sessionId: "s1", turn: turn(1, "bait") });
    expect(st.typing).toBeNull();
    st = applyEvent(st, { type: "typing", sessionId: "s1", side: "bait", on: true });
    st = applyEvent(st, { type: "typing", sessionId: "s1", side: "bait", on: false });
    expect(st.typing).toBeNull();
    expect(applyEvent(start, { type: "typing", sessionId: "other", side: "bait", on: true }).typing).toBeNull();
  });
});

describe("1. mock backend: same auto-reply rule as the server", () => {
  const script = { id: "inv-zh", type: "investment", lang: "zh", title: "t" } as ScamScriptDef;
  it("human scammer + AI decoy: one answer, typing around it; both human: none", async () => {
    vi.useFakeTimers();
    try {
      const b = createMockBackend({ scripts: [script] }, { tickMs: 50 });
      const s = await b.createSession("inv-zh", { scammer: "human", bait: "ai" });
      const events: string[] = [];
      b.subscribe(s.id, (e) => events.push(e.type === "typing" ? `typing:${e.on}` : e.type === "turn" ? `turn:${e.turn.side}:${e.turn.author}` : e.type));
      await b.say(s.id, "scammer", "你好");
      await b.say(s.id, "scammer", "在吗"); // second line while the answer is pending: still one answer
      await b.control(s.id, "step"); // step right after sending
      await vi.advanceTimersByTimeAsync(200);
      const turns = (await b.getSession(s.id)).turns;
      expect(turns.filter((t) => t.side === "bait")).toHaveLength(1);
      expect(events).toContain("typing:true");
      expect(events.at(-1)).toBe("typing:false");

      const both = await b.createSession("inv-zh", { scammer: "human", bait: "human" });
      await b.say(both.id, "scammer", "你好");
      await vi.advanceTimersByTimeAsync(200);
      expect((await b.getSession(both.id)).turns).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("2. training mode default + compact rating row", () => {
  it("on for a logged-in expert / reviewer, off logged out, in local mode and read-only", () => {
    expect(defaultTrainingMode({ loggedIn: true }, false)).toBe(true);
    expect(defaultTrainingMode({ loggedIn: true }, true)).toBe(false);
    expect(defaultTrainingMode({ loggedIn: false }, false)).toBe(false);
  });

  it("each decoy line shows one compact row (good / bad / risky / rewrite); tags and reason stay folded", () => {
    const html = renderToStaticMarkup(
      <I18nProvider lang="zh">
        <AnnotateBar turn={turn(1, "bait")} expert="老周" session={session} backend={{} as Backend} />
      </I18nProvider>,
    );
    expect(html).toContain("annot-row");
    expect(html).toMatch(/改写/);
    expect(html.match(/class="rate /g)).toHaveLength(4);
    expect(html).not.toContain("tag-pick");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("专家名");
  });
});

describe("3. landing after login", () => {
  it("expert → arena; reviewer → review queue / sessions when work waits, else arena", () => {
    expect(landingFor({ role: "expert" }, { corrections: 3, addresses: 1 })).toBe("#/arena");
    expect(landingFor({ role: "reviewer" }, { corrections: 2, addresses: 0 })).toBe("#/training/review");
    expect(landingFor({ role: "reviewer" }, { corrections: 0, addresses: 1 })).toBe("#/sessions");
    expect(landingFor({ role: "reviewer" }, { corrections: 0, addresses: 0 })).toBe("#/arena");
    expect(landingFor({ role: "reviewer" }, null)).toBe("#/arena");
  });

  it("counts pending rewrites and unfiltered pending addresses; a slow / failing backend never blocks login", async () => {
    const backend = {
      listCorrections: async () => [corr("pending"), corr("approved"), corr("pending")],
      listRecordedSessions: async () => [sess(["pending", "approved"]), sess(["pending"])],
    };
    expect(await pendingWork(backend)).toEqual({ corrections: 2, addresses: 2 });
    const failing = { listCorrections: async () => Promise.reject(new Error("403")), listRecordedSessions: async () => [] };
    expect(await pendingWork(failing)).toEqual({ corrections: 0, addresses: 0 });
    const slow = { listCorrections: () => new Promise<Correction[]>(() => undefined), listRecordedSessions: async () => [] };
    expect(await pendingWork(slow, 10)).toBeNull();
    const me = { authEnabled: true, expertId: "r", name: "R", role: "reviewer" as const };
    expect(await afterLogin(me, backend)).toBe("#/training/review");
    expect(await afterLogin({ ...me, role: "expert" }, backend)).toBe("#/arena");
    expect(await afterLogin(me, null)).toBe("#/arena");
  });
});

describe("4. phone nav for logged-in users", () => {
  it("expert / reviewer on a phone: work pages first, demo pages under More", () => {
    const e = compactNav("expert", true)!;
    expect(e.primary).toEqual(["arena", "training", "sessions", "eval"]);
    expect(e.more).toEqual(["guide", "replay", "alerts", "guard", "flows", "responders", "tee"]);
    const r = compactNav("reviewer", true)!;
    expect(r.primary).toEqual(["arena", "training", "sessions", "eval", "team", "alerts"]);
    expect(r.more).not.toContain("alerts");
  });
  it("desktop and logged-out / judge views keep the full nav", () => {
    expect(compactNav("expert", false)).toBeNull();
    expect(compactNav(null, true)).toBeNull();
  });
});

describe("5. pasted chat text", () => {
  it("becomes the same upload a .txt file would make", () => {
    expect(pastedUpload("  \n ", "u")).toBeNull();
    expect(pastedUpload("对方：你好\r\n我：你好\r\n", "u")).toEqual({ filename: "pasted.txt", content: "对方：你好\n我：你好", encoding: "utf8", expertId: "u" });
  });

  it("goes through the same analysis (mock backend), zero-retention flag passed on", async () => {
    const sample = readFileSync(fileURLToPath(new URL("../../../fixtures/training/samples/zh-pig-butchering.txt", import.meta.url)), "utf8");
    const text = sample.split("\n").slice(0, 20).join("\n");
    const b = createMockBackend({ scripts: [] });
    const a = await b.upload(pastedUpload(text, "专家A")!, { ephemeral: true });
    expect(a.filename).toBe("pasted.txt");
    expect(a.lang).toBe("zh");
    expect(a.stages.length).toBeGreaterThan(0);
    expect(a.redactedText).toContain("\n");
  });
});

describe("6. sample-data notice", () => {
  it("hidden with the live HTTP backend (pages read the server), shown for replay / mock, lists only what was filled", () => {
    expect(visibleSampleSections(["arenaSessions", "eval"], "http")).toBeNull();
    expect(visibleSampleSections(["arenaSessions", "eval"], "replay")).toEqual(["arenaSessions", "eval"]);
    expect(visibleSampleSections(["corrections"], "mock")).toEqual(["corrections"]);
    expect(visibleSampleSections([], "mock")).toBeNull();
    expect(visibleSampleSections(undefined, "replay")).toBeNull();
  });
});
