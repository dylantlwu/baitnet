// @vitest-environment jsdom
/** D34 scammer side (docs/design/骗子人物卡.md): mask + operator card, scammer thoughts, scammer mind, visibility, difficulty. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ArenaSession, ArenaTurn, EvalCase, EvalReport, ScammerCard, ScammerMind, ScriptCover, SideMode } from "@baitnet/shared";
import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import {
  ScammerLine, ScammerMindCard, nameSaid, scammerMindUpTo, scammerViewAllowed, sessionScammerMode, situationTag,
} from "./ScammerMind";
import { ScriptPicker, SessionLayout, TurnRow } from "../pages/ArenaPage";
import { EvalPage, summarize } from "../pages/EvalPage";
import { StaticBackendProvider } from "../backend/context";
import { createHttpBackend } from "../backend/http";
import { createMockBackend } from "../backend/mock";
import { normalizeScripts } from "../backend/normalize";
import { SUSPICION_DELTA, suspicionDelta } from "../backend/scammers";
import type { Backend } from "../backend/types";
import type { ViewSnapshot } from "../data/parse";
import { arenaReducer, initialArena } from "./reducer";
import { SCAM_TYPES } from "../scriptlab/analyze";

afterEach(cleanup);

const wrap = (ui: ReactNode, lang: "zh" | "en" = "zh") => render(<I18nProvider lang={lang}>{ui}</I18nProvider>);
const snap = { alerts: [] } as unknown as ViewSnapshot;

const card: ScammerCard = {
  id: "zh-test", lang: "zh", handle: "阿杰", age: 23, fitsScamTypes: ["pig-butchering"],
  situation: "园区，夜班，一人管 6 个号", pressure: "每月 3 单", scriptDiscipline: "照抄开场",
  slips: ["半夜秒回"], suspicionTriggers: ["问得太细"], tests: ["发语音报名字"], onSuspicion: ["换地址"], limits: ["不开视频"],
  voice: { style: "热情", catchphrases: ["相信我"], quirks: ["句尾带哈"] },
};
const cover: ScriptCover = {
  name: "许曼宁", age: 34, job: "珠宝商", location: "香港", backstory: "跟着舅舅做珠宝批发。", people: ["舅舅：分析师"], props: ["盈利截图"], cannotDo: ["店里信号不好"],
};
const mind: ScammerMind = {
  scammerId: card.id,
  facts: [
    { turn: 0, fact: "自称许曼宁" },
    { turn: 4, fact: "说舅舅在平台" },
  ],
  baitSuspicion: { score: 72, signals: ["问得太细", "秒回"] },
  plan: "让对方发语音",
  actions: [{ turn: 4, action: "test", detail: "发语音报名字" }],
};
const sTurn = (extra: Partial<ArenaTurn> = {}): ArenaTurn => ({
  index: 0, side: "scammer", text: "你好呀，我是许曼宁", author: "ai", ts: "2026-11-11T08:00:00Z",
  scammerMind: { think: "这人问得太细", plan: "先试探", baitSuspicion: 64, action: "test" }, ...extra,
});
const session = (modes: Record<"scammer" | "bait", SideMode>, extra: Partial<ArenaSession> = {}): ArenaSession => ({
  id: "s1", scriptId: "x", engine: "nearai", modes, status: "paused", turns: [sTurn()], drafts: [], createdAt: "t",
  scammer: { card, cover }, scammerMind: mind, ...extra,
});

describe("D34 visibility rule", () => {
  it("decoy side played by a human (human / ai+whisper) never sees the scammer side", () => {
    const cases: [SideMode, SideMode, boolean][] = [
      ["ai", "ai", true], // spectating
      ["human", "ai", true], // human plays the scammer
      ["ai+whisper", "ai", true],
      ["ai", "human", false],
      ["ai", "ai+whisper", false],
      ["human", "human", false],
      ["human", "ai+whisper", false],
    ];
    for (const [scammer, bait, ok] of cases) expect(scammerViewAllowed({ scammer, bait }), `${scammer}/${bait}`).toBe(ok);
    expect(scammerViewAllowed(undefined)).toBe(false);
  });

  it("nameSaid only counts scammer lines", () => {
    expect(nameSaid("许曼宁", [{ side: "scammer", text: "我是许曼宁" }])).toBe(true);
    expect(nameSaid("许曼宁", [{ side: "bait", text: "许曼宁是谁" }])).toBe(false);
    expect(nameSaid("", [{ side: "scammer", text: "x" }])).toBe(false);
  });

  const layout = (s: ArenaSession) =>
    wrap(<SessionLayout session={s} snap={snap} network="testnet" txHashes={{}} safetyCount={0} err={null} controls={null} training={false} readOnly />);

  it("spectating: scammer line, sheet, 心里话 and the mind card are all shown", () => {
    layout(session({ scammer: "ai", bait: "ai" }));
    const line = screen.getByRole("button", { name: /骗子：/ });
    expect(line.textContent).toContain("许曼宁（面具）");
    expect(line.textContent).toContain("真人：阿杰");
    expect(line.textContent).toContain("园区");
    expect(screen.getByText(zh["smind.mindCard"])).toBeTruthy();
    expect(screen.getByRole("button", { name: /💭/ })).toBeTruthy();
  });

  for (const bait of ["human", "ai+whisper"] as const) {
    it(`human on the decoy side (${bait}): no card, no mask details, no 心里话, no mind card`, () => {
      const { container } = layout(session({ scammer: "ai", bait }));
      expect(screen.queryByRole("button", { name: /骗子：/ })).toBeNull();
      expect(screen.queryByText(zh["smind.mindCard"])).toBeNull();
      expect(screen.queryByRole("button", { name: /💭/ })).toBeNull();
      const text = container.textContent ?? "";
      for (const secret of ["阿杰", "珠宝商", "跟着舅舅", "这人问得太细", "72/100", "园区"]) expect(text, secret).not.toContain(secret);
      // only the name the scammer already said in the chat
      expect(screen.getByTestId("scammer-line-public").textContent).toBe(`${zh["smind.saidName"]}许曼宁`);
    });
  }

  it("human on the decoy side and the name not said yet: no scammer line at all", () => {
    layout(session({ scammer: "ai", bait: "human" }, { turns: [sTurn({ text: "你好呀" })] }));
    expect(screen.queryByTestId("scammer-line-public")).toBeNull();
  });

  it("human plays the scammer: sees their own card and mask", () => {
    layout(session({ scammer: "human", bait: "ai" }, { turns: [sTurn({ author: "human", scammerMind: undefined })] }));
    fireEvent.click(screen.getByRole("button", { name: /骗子：/ }));
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toContain(zh["smind.cover"]);
    expect(dlg.textContent).toContain(zh["smind.card"]);
  });
});

describe("scammer line + sheet", () => {
  it("renders nothing without data", () => {
    const { container } = wrap(<ScammerLine allowed />);
    expect(container.innerHTML).toBe("");
  });

  it("tap opens a sheet with 面具 and 真人; Esc closes", () => {
    wrap(<ScammerLine scammer={{ card, cover }} allowed turns={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /骗子：/ }));
    const dlg = screen.getByRole("dialog");
    const mask = within(dlg).getByRole("region", { name: zh["smind.cover"] });
    for (const s of [cover.backstory, cover.people[0]!, cover.props[0]!, cover.cannotDo[0]!, "香港"]) expect(mask.textContent).toContain(s);
    const real = within(dlg).getByRole("region", { name: zh["smind.card"] });
    for (const s of [card.situation, card.pressure, card.slips[0]!, card.suspicionTriggers[0]!, card.tests[0]!, card.onSuspicion[0]!, card.limits[0]!, "「相信我」"])
      expect(real.textContent).toContain(s);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("English, mask only (no card) never crashes", () => {
    wrap(<ScammerLine scammer={{ cover } as ArenaSession["scammer"]} allowed turns={[]} />, "en");
    const line = screen.getByRole("button", { name: /Scammer:/ });
    expect(line.textContent).toContain("许曼宁 (mask)");
    fireEvent.click(line);
    expect(screen.getByRole("dialog").textContent).toContain(en["smind.cover"]);
  });

  it("situationTag keeps the first clause", () => {
    expect(situationTag("园区话务组，夜班")).toBe("园区话务组");
    expect(situationTag("Rented office floor, day shift")).toBe("Rented office floor");
    expect(situationTag(undefined)).toBe("");
  });
});

describe("心里话 under AI scammer lines", () => {
  const row = (turn: ArenaTurn, modes: Record<"scammer" | "bait", SideMode>) =>
    wrap(<TurnRow turn={turn} snap={snap} training={false} expert="" session={session(modes)} />);

  it("collapsed by default; tap shows think, plan, suspicion and the action badge", () => {
    row(sTurn(), { scammer: "ai", bait: "ai" });
    expect(screen.queryByText("这人问得太细")).toBeNull();
    const chip = screen.getByRole("button", { name: /💭/ });
    expect(chip.getAttribute("title")).toBe(zh["smind.turnHint"]);
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/这人问得太细/)).toBeTruthy();
    expect(screen.getByText(/先试探/)).toBeTruthy();
    expect(screen.getByText("64/100")).toBeTruthy();
    expect(screen.getByText(zh["saction.test"])).toBeTruthy();
  });

  it("hidden while a human plays the decoy, and on human scammer lines", () => {
    row(sTurn(), { scammer: "ai", bait: "human" });
    expect(screen.queryByRole("button", { name: /💭/ })).toBeNull();
    cleanup();
    row(sTurn(), { scammer: "ai", bait: "ai+whisper" });
    expect(screen.queryByRole("button", { name: /💭/ })).toBeNull();
    cleanup();
    row(sTurn({ author: "human" }), { scammer: "human", bait: "ai" });
    expect(screen.queryByRole("button", { name: /💭/ })).toBeNull();
  });
});

describe("scammer mind card", () => {
  it("meter, signals, facts (expandable), actions log", () => {
    wrap(<ScammerMindCard mind={mind} defaultOpen />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("72");
    expect(screen.getAllByText("72/100").length).toBeGreaterThan(0);
    expect(screen.getByText("问得太细")).toBeTruthy();
    expect(screen.getByText("面具说过的事 2 条")).toBeTruthy();
    expect(screen.getByText(/说舅舅在平台/)).toBeTruthy();
    expect(screen.getByText(/发语音报名字/)).toBeTruthy();
  });

  it("folded by default on phones; empty / odd minds never crash", () => {
    const prev = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("640"), media: q }) as MediaQueryList) as typeof window.matchMedia;
    try {
      const { container } = wrap(<ScammerMindCard mind={mind} />);
      expect(container.querySelector("details.smind-card")!.hasAttribute("open")).toBe(false);
    } finally {
      window.matchMedia = prev;
    }
    cleanup();
    wrap(<ScammerMindCard mind={{ scammerId: "x" } as unknown as ScammerMind} defaultOpen />);
    expect(screen.getByText(zh["smind.noScore"])).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    cleanup();
    expect(wrap(<ScammerMindCard />).container.innerHTML).toBe("");
  });

  it("replay shows only what the scammer knew so far", () => {
    const turns = [sTurn({ index: 0, scammerMind: { think: "", baitSuspicion: 10 } }), sTurn({ index: 1, side: "bait", scammerMind: undefined })];
    const m = scammerMindUpTo(mind, turns)!;
    expect(m.facts).toHaveLength(1);
    expect(m.actions).toHaveLength(0);
    expect(m.baitSuspicion.score).toBe(10);
    expect(scammerMindUpTo(mind, [])!.baitSuspicion.score).toBe(0);
  });

  it("reducer fills the scammer state and per-line notes from a re-read", () => {
    const base = session({ scammer: "ai", bait: "ai" }, { scammer: undefined, scammerMind: undefined, turns: [sTurn({ scammerMind: undefined })] });
    let st = arenaReducer(initialArena, { type: "session", session: base });
    st = arenaReducer(st, { type: "mind", sessionId: "s1", scammer: { card, cover }, scammerMind: mind, turns: [sTurn()] });
    expect(st.session!.scammer?.card.handle).toBe("阿杰");
    expect(st.session!.scammerMind?.baitSuspicion.score).toBe(72);
    expect(st.session!.turns[0]!.scammerMind?.baitSuspicion).toBe(64);
  });
});

describe("scammer difficulty (scammerMode)", () => {
  it("http backend sends scammerMode only when chosen", async () => {
    const bodies: Record<string, unknown>[] = [];
    const b = createHttpBackend("http://x", (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response('{"id":"s"}', { status: 200 });
    }) as unknown as typeof fetch);
    await b.createSession("x", { scammer: "ai", bait: "ai" }, "glm", { scammerMode: "easy" });
    await b.createSession("x", { scammer: "ai", bait: "ai" }, undefined, { scammerMode: "real" });
    await b.createSession("x", { scammer: "ai", bait: "ai" });
    expect(bodies[0]).toEqual({ scriptId: "x", scammer: "ai", bait: "ai", modelChoice: "glm", scammerMode: "easy" });
    expect(bodies[1]!.scammerMode).toBe("real");
    expect("scammerMode" in bodies[2]!).toBe(false);
  });

  it("picker: defaults to real, switching to easy sends easy", async () => {
    const createSession = vi.fn(async () => session({ scammer: "ai", bait: "ai" }));
    const backend = { kind: "http", readOnly: false, createSession } as unknown as Backend;
    wrap(<ScriptPicker scripts={normalizeScripts([{ id: "s1", title: "S1" }])} recorded={[]} backend={backend} picked="s1" onPick={() => undefined} onStart={() => undefined} />);
    const group = screen.getByRole("radiogroup", { name: zh["arena.scammerMode"] });
    expect(within(group).getByRole("radio", { name: zh["arena.scammerMode.real"] }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: zh["arena.start"] }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0]).toEqual(["s1", { scammer: "ai", bait: "ai" }, expect.any(String), { scammerMode: "real" }]);
    fireEvent.click(within(group).getByRole("radio", { name: zh["arena.scammerMode.easy"] }));
    fireEvent.click(screen.getByRole("button", { name: zh["arena.start"] }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    expect((createSession.mock.calls[1] as unknown[])[3]).toEqual({ scammerMode: "easy" });
  });

  it("sessionScammerMode reads the optional field defensively; easy shows a badge", () => {
    expect(sessionScammerMode({ scammerMode: "easy" })).toBe("easy");
    expect(sessionScammerMode({ scammerMode: "hard" })).toBeUndefined();
    expect(sessionScammerMode(null)).toBeUndefined();
    wrap(
      <SessionLayout session={{ ...session({ scammer: "ai", bait: "ai" }), scammerMode: "easy" } as ArenaSession} snap={snap} network="testnet" txHashes={{}} safetyCount={0} err={null} controls={null} training={false} readOnly />,
    );
    expect(screen.getByText(zh["arena.scammerEasyBadge"])).toBeTruthy();
  });

  it("mock: card + mask attached, rules suspicion is pinned, real mode tests the decoy, easy mode does not", async () => {
    expect(suspicionDelta("今天天气不错，我刚买完菜", "zh")).toEqual({ delta: SUSPICION_DELTA.smallTalk, signals: [] });
    expect(suspicionDelta("你是不是骗子？我要报警了？到底是谁？", "zh").delta).toBe(SUSPICION_DELTA.police + SUSPICION_DELTA.manyQuestions);
    expect(suspicionDelta("As an AI, I cannot assist with that.", "en").delta).toBe(SUSPICION_DELTA.aiTell);
    expect(suspicionDelta("my address is 0x1100abc", "en").delta).toBe(SUSPICION_DELTA.smallTalk);

    const scripts = normalizeScripts([{ id: "m1", title: "M", type: "pig-butchering", lang: "zh", persona: "在香港做珠宝生意的“阿杰”", hook: "你好呀" }]);
    const run = async (scammerMode: "easy" | "real") => {
      const m = createMockBackend({ scripts }, { tickMs: 1 });
      const s = await m.createSession("m1", { scammer: "ai", bait: "human" }, undefined, { scammerMode });
      expect(s.scammer?.card.lang).toBe("zh");
      expect(s.scammer?.cover?.name).toBe("阿杰");
      expect(sessionScammerMode(s)).toBe(scammerMode);
      await m.control(s.id, "step"); // scammer opens
      for (let i = 0; i < 3; i++) {
        await m.say(s.id, "bait", "你是警察吗？是不是 AI？到底是谁？");
        await new Promise((r) => setTimeout(r, 20));
      }
      return m.getSession(s.id);
    };
    const real = await run("real");
    expect(real.scammerMind!.baitSuspicion.score).toBeGreaterThanOrEqual(60);
    expect(real.scammerMind!.actions.some((a) => a.action === "test")).toBe(true);
    expect(real.turns.filter((t) => t.side === "scammer").every((t) => t.scammerMind && typeof t.scammerMind.baitSuspicion === "number")).toBe(true);
    const easy = await run("easy");
    expect(easy.scammerMind!.baitSuspicion.score).toBeGreaterThanOrEqual(60);
    expect(easy.scammerMind!.actions).toEqual([]);
  });

  it("mock: two turns at 90+ in real mode vanish and end the session", async () => {
    const scripts = normalizeScripts([{ id: "m1", title: "M", type: "investment", lang: "en", hook: "Hi" }]);
    const m = createMockBackend({ scripts }, { tickMs: 1 });
    const s = await m.createSession("m1", { scammer: "ai", bait: "human" }, undefined, { scammerMode: "real" });
    await m.control(s.id, "step");
    for (let i = 0; i < 6; i++) {
      const cur = await m.getSession(s.id);
      if (cur.status === "finished") break;
      await m.say(s.id, "bait", "As an AI language model, should I call the police? Who? Why? Where?");
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = await m.getSession(s.id);
    expect(done.status).toBe("finished");
    expect(done.scammerMind!.actions.at(-1)!.action).toBe("vanish");
  });
});

describe("eval: decoy suspicion + vanished", () => {
  const c = (id: string, extra: Partial<EvalCase>): EvalCase => ({
    scriptId: id, type: "investment", engine: "rules", turns: 8, extracted: true, leaked: false, hijacked: false, onChain: true, notes: [], ...extra,
  });

  it("summarize averages suspicion and counts vanished", () => {
    const s = summarize([c("a", { baitSuspicion: 20, scammerVanished: false }), c("b", { baitSuspicion: 60, scammerVanished: true }), c("c", {})]);
    expect(s.avgBaitSuspicion).toBe(40);
    expect(s.suspicionTotal).toBe(2);
    expect(s.vanished).toBe(1);
    expect(s.vanishTotal).toBe(2);
    expect(summarize([c("x", {})]).suspicionTotal).toBe(0);
  });

  it("eval page shows the metric cards and per-case columns only when the report has them", async () => {
    const report: EvalReport = {
      generatedAt: "2026-11-11T00:00:00Z", engine: "rules",
      cases: [c("investment-zh-01", { baitSuspicion: 20, scammerVanished: false }), c("investment-zh-02", { baitSuspicion: 81, scammerVanished: true, extracted: false })],
      summary: { total: 2, extracted: 1, leaked: 0, hijacked: 0, poisonTotal: 0, poisonFiltered: 0, onChain: 2, avgTurnsToExtract: 4 },
    };
    const backend = { getEval: async () => report, listScripts: async () => [] } as unknown as Backend;
    wrap(<StaticBackendProvider backend={backend}><EvalPage /></StaticBackendProvider>);
    await waitFor(() => expect(screen.getAllByText(zh["eval.m.baitSuspicion"]).length).toBeGreaterThan(0));
    expect(screen.getAllByText(zh["eval.m.vanished"]).length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: zh["eval.col.baitSuspicion"] })).toBeTruthy();
    expect(screen.getByText("81/100")).toBeTruthy();
    cleanup();
    const old = { ...report, cases: report.cases.map(({ baitSuspicion: _a, scammerVanished: _b, ...r }) => r) };
    const b2 = { getEval: async () => old, listScripts: async () => [] } as unknown as Backend;
    wrap(<StaticBackendProvider backend={b2}><EvalPage /></StaticBackendProvider>);
    await waitFor(() => expect(screen.getAllByText(zh["eval.m.extract"]).length).toBeGreaterThan(0));
    expect(screen.queryByText(zh["eval.m.baitSuspicion"])).toBeNull();
    expect(screen.queryByRole("columnheader", { name: zh["eval.col.baitSuspicion"] })).toBeNull();
  });
});

describe("D34 scam types", () => {
  it("the three new types are filterable with zh/en labels", () => {
    for (const ty of ["authority-impersonation", "otc-mule", "liquidity-mining"] as const) {
      expect(SCAM_TYPES).toContain(ty);
      expect(zh[`type.${ty}`]).toBeTruthy();
      expect(en[`type.${ty}`]).toBeTruthy();
    }
    expect(zh["type.authority-impersonation"]).toBe("冒充公检法");
    expect(en["type.otc-mule"]).toBe("OTC money mule");
  });
});
