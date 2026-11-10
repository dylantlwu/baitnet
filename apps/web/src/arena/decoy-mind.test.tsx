// @vitest-environment jsdom
/** D32 decoy mind (docs/design/诱饵心智.md): persona card, per-line thoughts, mind card, principle tags, eval metrics. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Annotation, ArenaSession, ArenaTurn, DecoyMind, DecoyPersona, EvalCase, EvalReport } from "@baitnet/shared";
import { I18nProvider } from "../i18n";
import { DecoyMindCard, PersonaLine, intelCount, mindUpTo, personaSummary } from "./DecoyMind";
import { AnnotateBar, TurnRow } from "../pages/ArenaPage";
import { EvalPage, summarize } from "../pages/EvalPage";
import { StaticBackendProvider } from "../backend/context";
import type { Backend } from "../backend/types";
import type { ViewSnapshot } from "../data/parse";
import { arenaReducer, initialArena } from "./reducer";

afterEach(cleanup);

const personas = (lang: "zh" | "en") =>
  JSON.parse(readFileSync(join(process.cwd(), "../../fixtures/personas", `${lang}.json`), "utf8")) as DecoyPersona[]; // vitest runs in apps/web
const zhP = personas("zh")[0]!;
const enP = personas("en")[0]!;

const wrap = (ui: ReactNode, lang: "zh" | "en" = "zh") => render(<I18nProvider lang={lang}>{ui}</I18nProvider>);

const session: ArenaSession = {
  id: "s1", scriptId: "x", engine: "nearai", modes: { scammer: "ai", bait: "ai" }, status: "paused", turns: [], drafts: [], createdAt: "t",
};
const baitTurn = (extra: Partial<ArenaTurn> = {}): ArenaTurn => ({ index: 1, side: "bait", text: "有客人来了 等下", author: "ai", ts: "2026-11-11T08:00:00Z", ...extra });
const snap = { alerts: [] } as unknown as ViewSnapshot;

const mind: DecoyMind = {
  personaId: zhP.id,
  facts: [
    { turn: 1, fact: "我女儿叫思琪" },
    { turn: 3, fact: "店在祖庙附近" },
  ],
  intel: { address: "TXyz1234567890abcdefghijklmnopqrstuv", chain: "TRC20", platform: "鼎盛国际" },
  plan: "说小额转账失败，要备用地址",
  scammerAi: { score: 72, signals: ["秒回", "模板话术"] },
  checks: [{ turn: 3, issue: "knowledge-leak", detail: "说了 TRC20", rewritten: true }],
};

describe("persona line + card", () => {
  it("renders nothing without a persona (old sessions, rules mode)", () => {
    const { container } = wrap(<PersonaLine />);
    expect(container.innerHTML).toBe("");
  });

  it("one compact line; tapping opens the full card; Esc closes it", () => {
    wrap(<PersonaLine persona={zhP} />);
    const line = screen.getByRole("button", { name: /诱饵：/ });
    expect(line.textContent).toContain(`${zhP.name} · ${zhP.age} · ${zhP.city}`);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(line);
    const dlg = screen.getByRole("dialog");
    for (const s of [zhP.background, zhP.money, zhP.family[0]!, zhP.routine, zhP.wants, zhP.limits[0]!, zhP.knows[0]!, zhP.doesNotKnow[0]!, zhP.voice.style, zhP.stallExcuses[0]!])
      expect(dlg.textContent).toContain(s);
    expect(dlg.textContent).toContain("不懂的词");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("English card, and a half-filled persona never crashes", () => {
    wrap(<PersonaLine persona={enP} />, "en");
    fireEvent.click(screen.getByRole("button", { name: /Decoy:/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Stalling excuses");
    cleanup();
    const thin = { id: "x", lang: "zh", name: "阿梅", age: 40, city: "", job: "" } as unknown as DecoyPersona;
    wrap(<PersonaLine persona={thin} />);
    fireEvent.click(screen.getByRole("button", { name: /阿梅/ }));
    expect(screen.getByRole("dialog").textContent).toContain("阿梅");
    expect(personaSummary(thin)).toBe("阿梅 · 40");
  });
});

describe("心里话 under AI decoy lines", () => {
  it("collapsed by default; tap shows think / plan / new facts", () => {
    const turn = baitTurn({ mind: { think: "他催得急，像模板", plan: "装作转账失败", newFacts: ["我侄子叫阿杰"] } });
    wrap(<TurnRow turn={turn} snap={snap} training={false} expert="" session={session} />);
    const chip = screen.getByRole("button", { name: /心里话/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/他催得急/)).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByText(/他催得急/)).toBeTruthy();
    expect(screen.getByText(/装作转账失败/)).toBeTruthy();
    expect(screen.getByText("我侄子叫阿杰")).toBeTruthy();
  });

  it("no chip without a mind, on an empty mind, or on scammer lines", () => {
    wrap(<TurnRow turn={baitTurn()} snap={snap} training={false} expert="" session={session} />);
    wrap(<TurnRow turn={baitTurn({ index: 2, mind: { think: " " } })} snap={snap} training={false} expert="" session={session} />);
    wrap(<TurnRow turn={baitTurn({ index: 3, side: "scammer", mind: { think: "x" } })} snap={snap} training={false} expert="" session={session} />);
    expect(screen.queryByRole("button", { name: /心里话/ })).toBeNull();
  });
});

describe("诱饵心智 card", () => {
  it("renders nothing without decoyMind", () => {
    const { container } = wrap(<DecoyMindCard />);
    expect(container.innerHTML).toBe("");
  });

  it("8 intel slots ticked when present (value shortened), facts, bot score + signals, check hits", () => {
    const { container } = wrap(<DecoyMindCard mind={mind} defaultOpen />);
    expect(intelCount(mind)).toBe(3);
    const items = container.querySelectorAll(".intel-list li");
    expect(items).toHaveLength(8);
    expect(container.querySelectorAll(".intel-list li.has")).toHaveLength(3);
    expect(container.textContent).toContain("收款地址");
    expect(container.textContent).toContain("备用地址");
    const addr = container.querySelector(".intel-list li.has .intel-value")!;
    expect(addr.textContent!.length).toBeLessThanOrEqual(28);
    expect(addr.getAttribute("title")).toBe(mind.intel.address);
    expect(container.textContent).toContain("情报 3/8");
    expect(container.textContent).toContain("说过的自己的事 2 条");
    expect(container.textContent).toContain("我女儿叫思琪");
    expect(container.textContent).toContain("72/100");
    expect(container.textContent).toContain("秒回");
    expect(container.textContent).toContain("自查发现问题 1 次");
    expect(container.textContent).toContain("用了不该懂的词");
    expect(container.textContent).toContain("已重写");
    expect(container.textContent).toContain("要备用地址");
  });

  it("folded on phones (summary still shows the counts); a sparse mind does not crash", () => {
    const { container } = wrap(<DecoyMindCard mind={{ personaId: "p", facts: [], intel: {}, scammerAi: { score: 0, signals: [] }, checks: [] }} defaultOpen={false} />);
    const d = container.querySelector("details.mind-card") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector("summary")!.textContent).toContain("0/8");
    cleanup();
    const odd = { personaId: "p" } as unknown as DecoyMind;
    expect(() => wrap(<DecoyMindCard mind={odd} defaultOpen />)).not.toThrow();
  });

  it("phone width starts folded by default", () => {
    const mm = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", mm);
    try {
      const { container } = wrap(<DecoyMindCard mind={mind} />);
      expect((container.querySelector("details.mind-card") as HTMLDetailsElement).open).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replay only shows facts / checks up to the line on screen", () => {
    const m = mindUpTo(mind, 2)!;
    expect(m.facts.map((f) => f.fact)).toEqual(["我女儿叫思琪"]);
    expect(m.checks).toEqual([]);
    expect(mindUpTo(undefined, 3)).toBeUndefined();
  });
});

describe("live session: mind refresh merges into the reducer state", () => {
  it("fills persona / decoyMind / turn.mind; ignores other sessions; absent fields keep the old value", () => {
    let st = arenaReducer(initialArena, { type: "session", session: { ...session, turns: [baitTurn()] } });
    st = arenaReducer(st, { type: "mind", sessionId: "other", decoyMind: mind });
    expect(st.session!.decoyMind).toBeUndefined();
    st = arenaReducer(st, { type: "mind", sessionId: "s1", persona: zhP, decoyMind: mind, turns: [baitTurn({ mind: { think: "t" } })] });
    expect(st.session!.persona!.name).toBe(zhP.name);
    expect(st.session!.decoyMind!.plan).toBe(mind.plan);
    expect(st.session!.turns[0]!.mind!.think).toBe("t");
    st = arenaReducer(st, { type: "mind", sessionId: "s1" });
    expect(st.session!.decoyMind).toBe(mind);
  });
});

describe("principle tags after rating", () => {
  function fakeBackend(withDelete = true) {
    let n = 0;
    const posted: Omit<Annotation, "id" | "at">[] = [];
    const postAnnotation = vi.fn(async (a: Omit<Annotation, "id" | "at">) => {
      posted.push(a);
      return { ...a, id: `ann${++n}`, at: "t" } as Annotation;
    });
    const deleteAnnotation = vi.fn(async () => undefined);
    const backend = { postAnnotation, ...(withDelete ? { deleteAnnotation } : {}) } as unknown as Backend;
    return { backend, posted, postAnnotation, deleteAnnotation };
  }
  const bar = (backend: Backend) => wrap(<AnnotateBar turn={baitTurn()} expert="老周" session={session} backend={backend} />);

  it("好 still saves with one tap; then 像真人 / 套到信息 / 前后一致 can be added and replace the first save", async () => {
    const f = fakeBackend();
    bar(f.backend);
    expect(screen.queryByRole("button", { name: "像真人" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "好" }));
    await waitFor(() => expect(f.postAnnotation).toHaveBeenCalledTimes(1));
    expect(f.posted[0]).toMatchObject({ rating: "good", tags: [] });
    await screen.findByRole("button", { name: "像真人" });
    expect(screen.getByRole("button", { name: "前后一致" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "露馅像AI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存标签" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "像真人" }));
    fireEvent.click(screen.getByRole("button", { name: "套到信息" }));
    expect(screen.getByRole("button", { name: "像真人" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await waitFor(() => expect(f.postAnnotation).toHaveBeenCalledTimes(2));
    expect(f.posted[1]).toMatchObject({ rating: "good", tags: ["p1-human", "p2-intel"], turnIndex: 1, sessionId: "s1" });
    await waitFor(() => expect(f.deleteAnnotation).toHaveBeenCalledWith("ann1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存标签" })).toBeNull());
  });

  it("差 opens the panel with 露馅像AI / 没套话 / 前后矛盾 next to the tactic tags; all go into tags", async () => {
    const f = fakeBackend(false); // older backend without delete: still saves
    bar(f.backend);
    fireEvent.click(screen.getByRole("button", { name: "差" }));
    const group = screen.getByRole("group", { name: /差在哪/ });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["露馅像AI", "没套话", "前后矛盾"]);
    expect(screen.queryByRole("button", { name: "像真人" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "前后矛盾" }));
    fireEvent.click(screen.getByRole("button", { name: "拖延" }));
    fireEvent.click(screen.getByRole("button", { name: "保存评分" }));
    await waitFor(() => expect(f.postAnnotation).toHaveBeenCalledTimes(1));
    expect(f.posted[0]!.rating).toBe("bad");
    expect([...f.posted[0]!.tags].sort()).toEqual(["p3-contradiction", "stalling"]);
  });

  it("有风险 has no principle tags; switching 差 → 好 drops the 差 tags", async () => {
    const f = fakeBackend();
    bar(f.backend);
    fireEvent.click(screen.getByRole("button", { name: "有风险" }));
    expect(screen.queryByRole("group")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "差" }));
    fireEvent.click(screen.getByRole("button", { name: "没套话" }));
    fireEvent.click(screen.getByRole("button", { name: "好" }));
    await waitFor(() => expect(f.postAnnotation).toHaveBeenCalledTimes(1));
    expect(f.posted[0]).toMatchObject({ rating: "good", tags: [] });
  });
});

describe("eval: 像真人 / 套到几项情报 / 前后一致", () => {
  const base: EvalCase = { scriptId: "inv-zh-01", type: "investment", engine: "rules", extracted: true, turnsToExtract: 4, turns: 10, leaked: false, hijacked: false, onChain: true, notes: [] };
  const cases: EvalCase[] = [
    { ...base, humanlike: true, intelSlots: 4, consistent: true },
    { ...base, scriptId: "inv-en-01", humanlike: false, intelSlots: 2, consistent: true },
  ];
  const report = (cs: EvalCase[]): EvalReport =>
    ({ generatedAt: "2026-11-11T00:00:00Z", engine: "rules", cases: cs, summary: {} }) as unknown as EvalReport;
  const page = (r: EvalReport) =>
    wrap(
      <StaticBackendProvider backend={{ getEval: async () => r, listScripts: async () => [] } as unknown as Backend}>
        <EvalPage />
      </StaticBackendProvider>,
    );

  it("summary counts only cases that carry the fields", () => {
    const s = summarize(cases);
    expect(s).toMatchObject({ humanlikeTotal: 2, humanlike: 1, consistentTotal: 2, consistent: 2, intelTotal: 2, avgIntelSlots: 3 });
    expect(summarize([base])).toMatchObject({ humanlikeTotal: 0, consistentTotal: 0, intelTotal: 0 });
  });

  it("shown per case and in the summary when present", async () => {
    const { container } = page(report(cases));
    await screen.findAllByText("像真人");
    expect(screen.getAllByText("平均套到几项情报").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("4/8");
    expect(container.textContent).toContain("3.0");
    expect(container.querySelectorAll("th").length).toBe(13);
  });

  it("hidden for older reports", async () => {
    const { container } = page(report([base]));
    await screen.findByText("inv-zh-01");
    expect(container.textContent).not.toContain("像真人");
    expect(container.querySelectorAll("th").length).toBe(10);
  });
});
