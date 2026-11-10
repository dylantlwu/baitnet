// @vitest-environment jsdom
/**
 * Fixes from the documentation walkthrough (items 1–15). UI checks use @testing-library/react in jsdom.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ArenaSession, ArenaTurn, AttestationResult, Correction, Me, ScriptAnalysis } from "@baitnet/shared";
import { AuthProvider, QUOTA_REFRESH_DELAY_MS, reloadAfterLogout, useAuth } from "./auth/context";
import { createMockAdmin, revokeKey, type AdminApi, type AuthState, type InviteRow } from "./auth/api";
import { I18nProvider } from "./i18n";
import { zh } from "./i18n/zh";
import { en } from "./i18n/en";
import { InviteList } from "./pages/TeamPage";
import { Switch } from "./components/ui";
import { AnalysisView, CorrectionCard, peopleNames, stageLines, TrainingPage } from "./pages/TrainingPage";
import { playsOf } from "./pages/SessionsPage";
import { UserChip } from "./App";
import { LLM_USED_EVENT, noteLlmUse } from "./lib/quota";
import { createHttpBackend, spendsQuota } from "./backend/http";
import { StaticBackendProvider } from "./backend/context";
import type { Backend } from "./backend/types";
import { analyzeUpload as analyzeLocally } from "./scriptlab/analyze";
import { NoEvalYet } from "./pages/EvalPage";
import { AttestationFold } from "./pages/TeePage";
import { DraftItem, modelPriceBadge, modelPriceTier, registryWhereKey } from "./pages/ArenaPage";
import { isTouchOnly, returnToArena, TourOverlay } from "./tour/Tour";
import { stepsFor } from "./tour/steps";
import type { ViewSnapshot } from "./data/parse";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const reviewer: Me = { authEnabled: true, expertId: "u_r1", name: "Dylan", role: "reviewer", llmQuota: { usedToday: 3, limitPerDay: 100 } };
const expert: Me = { authEnabled: true, expertId: "u_e1", name: "老周", role: "expert", llmQuota: { usedToday: 1, limitPerDay: 100 } };

function fakeAdmin(over: Partial<AdminApi> = {}): AdminApi {
  return {
    me: async () => ({ kind: "user", me: reviewer }),
    login: async () => reviewer,
    logout: async () => undefined,
    listInvites: async () => [],
    createInvite: async () => ({ code: "X", name: "x", role: "expert", createdBy: "d", createdAt: "t" }),
    revokeInvite: async () => undefined,
    listUsers: async () => [],
    listAudit: async () => [],
    ...over,
  };
}

function wrap(ui: React.ReactNode, opts: { state?: AuthState; admin?: AdminApi; backend?: Backend | null; onLoggedOut?: () => void; lang?: "zh" | "en" } = {}) {
  return render(
    <I18nProvider lang={opts.lang ?? "zh"}>
      <AuthProvider apiBase={null} ready={false} initialState={opts.state ?? { kind: "user", me: reviewer }} adminOverride={opts.admin} onLoggedOut={opts.onLoggedOut ?? (() => undefined)}>
        <StaticBackendProvider backend={opts.backend ?? null}>{ui}</StaticBackendProvider>
      </AuthProvider>
    </I18nProvider>,
  );
}

/* ───────────── 1. revoke ───────────── */

describe("1. team page: revoke sends the user id, not the masked code", () => {
  const invites: InviteRow[] = [
    { id: "u_abc123", code: "AB…GJ", name: "小王", role: "expert", createdBy: "Dylan", createdAt: "2026-11-10T00:00:00Z" },
    { code: "CD…KL", name: "无 id 的旧记录", role: "expert", createdBy: "Dylan", createdAt: "2026-11-10T00:00:00Z" },
  ];

  it("asks first, then revokes with the id", async () => {
    const revokeInvite = vi.fn(async () => undefined);
    const onChange = vi.fn();
    wrap(<InviteList invites={invites} err={null} onChange={onChange} />, { admin: fakeAdmin({ revokeInvite }) });
    const buttons = screen.getAllByRole("button", { name: "撤销" });
    expect(buttons).toHaveLength(1); // a masked code without id cannot be revoked: no dead button
    fireEvent.click(buttons[0]!);
    expect(revokeInvite).not.toHaveBeenCalled();
    expect(screen.getByText(/小王 会立刻被登出/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确定撤销" }));
    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith("u_abc123"));
    expect(onChange).toHaveBeenCalled();
  });

  it("cancel keeps the invite", () => {
    const revokeInvite = vi.fn(async () => undefined);
    wrap(<InviteList invites={invites} err={null} onChange={() => undefined} />, { admin: fakeAdmin({ revokeInvite }) });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(revokeInvite).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "撤销" })).toBeTruthy();
  });

  it("revokeKey: id first; masked codes are never sent", () => {
    expect(revokeKey(invites[0]!)).toBe("u_abc123");
    expect(revokeKey(invites[1]!)).toBeNull();
  });
});

/* ───────────── 2. contrast inside the decoy bubble ───────────── */

// jsdom gives import.meta.url an http: scheme; read the stylesheet relative to the test runner's cwd (apps/web)
const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
function tokens(block: string) {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]!] = m[2]!;
  return out;
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("2. training panel buttons inside the dark decoy bubble", () => {
  const light = tokens(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")));
  const dark = tokens(css.slice(css.indexOf("@media (prefers-color-scheme: dark)")));
  it("use the bubble's own colors (not page colors that vanish on it)", () => {
    expect(css).toMatch(/\.bait \.annot \.btn \{[^}]*color: var\(--bubble-b-text\)/);
    expect(css).toMatch(/\.bait \.annot \.btn\.primary \{[^}]*background: var\(--bubble-b-text\);[^}]*color: var\(--bubble-b\)/);
  });
  it("text / button contrast is WCAG AA (≥ 4.5:1) in light and dark mode", () => {
    for (const t of [light, dark]) expect(contrast(t["bubble-b-text"]!, t["bubble-b"]!)).toBeGreaterThanOrEqual(4.5);
    // what the old rules produced in light mode: page text on the dark bubble (the bug)
    expect(contrast(light["text"]!, light["bubble-b"]!)).toBeLessThan(3);
  });
});

/* ───────────── 3. switch ───────────── */

describe("3. switch: knob follows the state, by click and by keyboard", () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return (
      <>
        <Switch checked={on} onChange={setOn}>
          零留存
        </Switch>
        <span>{on ? "ON" : "OFF"}</span>
      </>
    );
  }
  it("click on the label", () => {
    render(<Harness />);
    const input = screen.getByRole("switch") as HTMLInputElement;
    const label = input.closest("label")!;
    expect(label.className).not.toContain(" on");
    fireEvent.click(screen.getByText("零留存"));
    expect(input.checked).toBe(true);
    expect(input.getAttribute("aria-checked")).toBe("true");
    expect(label.className).toContain("switch on");
    expect(screen.getByText("ON")).toBeTruthy();
  });
  it("keyboard: Space (native click) and Enter both toggle", () => {
    render(<Harness />);
    const input = screen.getByRole("switch") as HTMLInputElement;
    fireEvent.click(input); // what Space does on a focused checkbox
    expect(input.closest("label")!.className).toContain(" on");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.checked).toBe(false);
    expect(input.closest("label")!.className).not.toContain(" on");
  });
  it("css moves the knob for the on class too", () => {
    expect(css).toMatch(/\.switch\.on \.switch-track::after \{ transform: translateX\(14px\)/);
  });
});

/* ───────────── 5 + 7. names in the review queue ───────────── */

const corr: Correction = {
  id: "c1", sessionId: "s", turnIndex: 1, expertId: "u_1a2b3c4d5e", scriptId: "x", scamType: "investment", stage: 0, situation: "", badReply: "bad", goodReply: "good", rationale: "", tags: [], review: "approved", reviewer: "u_9f8e7d6c5b", at: "2026-11-09T00:00:00Z",
};

describe("5. submitter / reviewer shown by name", () => {
  it("uses the names the server adds; never a bare user id", () => {
    wrap(<CorrectionCard c={{ ...corr, expertName: "老周", reviewerName: "Dylan" } as Correction} backend={{ readOnly: false } as Backend} reviewer="Dylan" onDone={() => undefined} />);
    expect(screen.getByText(/老周 ·/)).toBeTruthy();
    expect(screen.getByText(/审核人：Dylan/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/u_[0-9a-f]{6,}/);
  });
  it("falls back to a neutral word for an id without a name; local-mode names stay", () => {
    expect(peopleNames(corr, "一位队友")).toEqual({ expert: "一位队友", reviewer: "一位队友" });
    expect(peopleNames({ ...corr, expertId: "Mia", reviewer: "Dylan" }, "x")).toEqual({ expert: "Mia", reviewer: "Dylan" });
  });
  it("a reviewer's own rewrite (by id) is not reviewable by them", () => {
    wrap(<CorrectionCard c={{ ...corr, review: "pending", reviewer: undefined, expertId: reviewer.expertId }} backend={{ readOnly: false } as Backend} reviewer="Dylan" onDone={() => undefined} />);
    expect(screen.getByText(/需要由其他审核者处理/)).toBeTruthy();
  });
});

describe("7. review queue header", () => {
  const backend = { kind: "http", readOnly: false, listCorrections: async () => [{ ...corr, review: "pending" as const, reviewer: undefined }] } as unknown as Backend;
  const snap = { network: "testnet" } as ViewSnapshot;
  it("experts see no 'reviewer <me>' label", async () => {
    wrap(<TrainingPage sub="review" snap={snap} />, { state: { kind: "user", me: expert }, backend });
    await screen.findByText(/等审核者处理/);
    expect(screen.queryByTestId("reviewer-label")).toBeNull();
  });
  it("reviewers still do", async () => {
    wrap(<TrainingPage sub="review" snap={snap} />, { state: { kind: "user", me: reviewer }, backend });
    expect((await screen.findByTestId("reviewer-label")).textContent).toContain("审核人");
  });
});

/* ───────────── 6. who played ───────────── */

describe("6. session list: who played which side follows the human lines", () => {
  const t = (index: number, side: "scammer" | "bait", author: "ai" | "human"): ArenaTurn => ({ index, side, author, text: "x", ts: "t" });
  const base = { modes: { scammer: "ai", bait: "ai" }, turns: [] as ArenaTurn[] } as unknown as ArenaSession;
  it("took over then handed back is not 'watching'", () => {
    expect(playsOf({ ...base, turns: [t(0, "scammer", "human"), t(1, "bait", "ai")] })).toBe("scammer");
    expect(playsOf({ ...base, turns: [t(0, "scammer", "ai"), t(1, "bait", "human")] })).toBe("bait");
    expect(playsOf({ ...base, turns: [t(0, "scammer", "human"), t(1, "bait", "human")] })).toBe("both");
    expect(playsOf({ ...base, turns: [t(0, "scammer", "ai"), t(1, "bait", "ai")] })).toBe("observer");
  });
  it("labels exist in both languages", () => {
    expect(zh["plays.both"]).toBe("两边都演");
    expect(en["plays.both"]).toBeTruthy();
  });
});

/* ───────────── 8. quota ───────────── */

describe("8. quota chip refreshes after LLM use (event-driven, debounced)", () => {
  it("a burst of LLM events = one /auth/me; the chip shows the new numbers", async () => {
    vi.useFakeTimers();
    let used = 3;
    const me = vi.fn(async () => ({ kind: "user" as const, me: { ...reviewer, llmQuota: { usedToday: used, limitPerDay: 100 } } }));
    wrap(<UserChip />, { admin: fakeAdmin({ me }) });
    expect(screen.getByText("3/100")).toBeTruthy();
    used = 6;
    act(() => {
      noteLlmUse();
      noteLlmUse();
      window.dispatchEvent(new Event(LLM_USED_EVENT));
    });
    expect(me).not.toHaveBeenCalled(); // not before things settle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTA_REFRESH_DELAY_MS + 10);
    });
    expect(me).toHaveBeenCalledTimes(1);
    expect(screen.getByText("6/100")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(me).toHaveBeenCalledTimes(1); // no polling
  });

  it("the http backend signals on AI turns and after an analysis", async () => {
    expect(spendsQuota({ type: "turn", sessionId: "s", turn: { index: 1, side: "bait", author: "ai", text: "x", ts: "t" } })).toBe(true);
    expect(spendsQuota({ type: "turn", sessionId: "s", turn: { index: 1, side: "bait", author: "human", text: "x", ts: "t" } })).toBe(false);
    const seen = vi.fn();
    window.addEventListener(LLM_USED_EVENT, seen);
    const f = (async () => new Response(JSON.stringify({ id: "a" }))) as unknown as typeof fetch;
    await createHttpBackend("", f).upload({ filename: "a.txt", content: "x", encoding: "utf8", expertId: "e" });
    window.removeEventListener(LLM_USED_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

/* ───────────── 9. line numbers ───────────── */

describe("9. analysis line numbers are not shifted by one", () => {
  const eight = Array.from({ length: 8 }, (_, i) => `对方: 第${i + 1}句`).join("\n");
  it("8 pasted lines → 第 1–8 行 (server stages are 1-based)", () => {
    const a = {
      id: "an-1", filename: "pasted.txt", format: "plain", lang: "zh", engine: "nearai", redactedText: eight, pii: [], warnings: [], artifacts: [], injections: [], alertDrafts: [],
      scamType: { value: "investment", confidence: 0.9, alternatives: [] },
      stages: [{ name: "接近", fromLine: 1, toLine: 8, tactics: [] }],
      draft: { id: "d", type: "investment", lang: "zh", title: "t", persona: "", hook: "", goal: "", stages: [], objections: [], plantedArtifacts: [], injections: [], source: "original" },
    } as unknown as ScriptAnalysis;
    wrap(<AnalysisView a={a} backend={{ readOnly: false } as Backend} network="testnet" expert="e" />);
    expect(screen.getByText("第 1–8 行")).toBeTruthy();
    expect(screen.queryByText("第 2–9 行")).toBeNull();
  });
  it("the local analyzer uses the same 1-based numbers", async () => {
    const a = await analyzeLocally({ filename: "pasted.txt", content: eight, encoding: "utf8", expertId: "e" });
    expect(a.stages[0]!.fromLine).toBe(1);
    expect(a.stages.at(-1)!.toLine).toBe(8);
    expect(stageLines(a.stages[0]!).a).toBe(1);
  });
});

/* ───────────── 10. plain-language texts ───────────── */

describe("10. texts an expert understands", () => {
  it("no keys / env names / pnpm commands in the visible upload and empty-state texts", () => {
    for (const d of [zh, en] as Record<string, string>[])
      for (const k of ["upload.imageNeedsKey", "upload.formats", "training.noRuns", "eval.empty", "eval.emptyExpert", "eval.emptyReviewer"]) {
        expect(d[k], k).not.toMatch(/pnpm|NEARAI_API_KEY|\bkey\b|Claude key/i);
      }
    expect(zh["upload.imageNeedsKey"]).toContain("截图识别暂不可用");
  });

  it("empty curve / report: experts are told a reviewer runs it; reviewers get a button", async () => {
    const runEval = vi.fn(async () => undefined);
    const backend = { kind: "http", readOnly: false, runEval } as unknown as Backend;
    wrap(<NoEvalYet what="curve" />, { state: { kind: "user", me: expert }, backend });
    expect(screen.getByText(/审核者跑一次评测后/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    wrap(<NoEvalYet what="report" />, { state: { kind: "user", me: reviewer }, backend });
    fireEvent.click(screen.getByRole("button", { name: "跑一次评测" }));
    await screen.findByText(/评测已开始/);
    expect(runEval).toHaveBeenCalledTimes(1);
  });

  it("zero-retention TEE proof: one folded line, details (in Chinese) on click", () => {
    const att: AttestationResult = {
      model: "m", nonce: "n", verified: true, recorded: false, at: "2026-11-09T00:00:00Z",
      checks: [{ name: "model: nonce echoed", pass: true, detail: "" }, { name: "gateway: TDX quote parses", pass: true, detail: "" }],
    };
    const { container } = wrap(<AttestationFold a={att} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("TEE 已验证 ✓（2/2 项通过）")).toBeTruthy();
    fireEvent.click(container.querySelector("summary")!);
    expect(details.open).toBe(true);
    expect(container.textContent).not.toContain("nonce echoed"); // translated check names
  });
});

/* ───────────── 11. model price labels ───────────── */

describe("11. model labels are not ambiguous", () => {
  it("exactly one 'cheapest' (GLM, tie broken by input price); GLM says it is slower", () => {
    expect(modelPriceTier("glm")).toBe("cheapest");
    expect(modelPriceTier("haiku")).toBe("cheap");
    const t = (k: string) => (zh as Record<string, string>)[k]!;
    expect(modelPriceBadge({ slow: true }, "cheapest", t)).toBe("最便宜 · 较慢");
    expect(modelPriceBadge({}, "cheap", t)).toBe("便宜");
  });
});

/* ───────────── 12. login example ───────────── */

describe("12. login code example matches real codes", () => {
  it("12 characters, no dashes, no look-alikes", () => {
    for (const s of [zh["auth.codePlaceholder"], en["auth.codePlaceholder"]]) {
      const ex = s.match(/[A-Z0-9]{6,}/)![0];
      expect(ex).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
      expect(s).not.toContain("BN-");
    }
  });
});

/* ───────────── 13. logout ───────────── */

describe("13. logout leaves nothing private on screen", () => {
  function LogoutButton() {
    const { logout } = useAuth();
    return (
      <button type="button" onClick={() => void logout()}>
        out
      </button>
    );
  }
  it("logout reloads the app on the login page", async () => {
    const onLoggedOut = vi.fn();
    const logout = vi.fn(async () => undefined);
    wrap(<LogoutButton />, { admin: fakeAdmin({ logout }), onLoggedOut });
    fireEvent.click(screen.getByText("out"));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(logout).toHaveBeenCalled();
    const loc = { hash: "#/sessions", reload: vi.fn() };
    reloadAfterLogout(loc);
    expect(loc.hash).toBe("#/login");
    expect(loc.reload).toHaveBeenCalled();
  });
});

/* ───────────── 14. publish confirm ───────────── */

describe("14. 'approve & publish' asks first", () => {
  const draft = { chain: "evm" as const, address: "0x" + "ab".repeat(20), level: "L1" as const, category: "investment", evidenceHash: "", conversationId: "s", review: "pending" as const };
  it("nothing is published until the dialog is confirmed; the dialog says testnet and no undo", () => {
    const onReview = vi.fn();
    wrap(<ul><DraftItem d={draft} i={0} network="testnet" readOnly={false} busy={false} onReview={onReview} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "复核通过，上链" }));
    expect(onReview).not.toHaveBeenCalled();
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toContain("NEAR 测试网");
    expect(dlg.textContent).toContain("不能撤回");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复核通过，上链" }));
    fireEvent.click(screen.getByRole("button", { name: "确认上链" }));
    expect(onReview).toHaveBeenCalledWith(0, true);
  });
  it("where-key per network", () => {
    expect(registryWhereKey("testnet")).toBe("arena.whereTestnet");
    expect(registryWhereKey("memory")).toBe("arena.whereLocal");
  });
});

/* ───────────── 15. tour ───────────── */

describe("15. tour on phones and at the end", () => {
  const mm = (coarse: boolean) => ({ matchMedia: (q: string) => ({ matches: q.includes("coarse") ? coarse : !coarse }) });
  it("touch-only devices: no keyboard hint", () => {
    expect(isTouchOnly(mm(true))).toBe(true);
    expect(isTouchOnly(mm(false))).toBe(false);
    expect(zh["tour.welcome.body"]).not.toContain("Esc");
    expect(en["tour.welcome.body"]).not.toContain("Esc");
  });
  it("the hint shows on the first step with a keyboard, not on a phone", () => {
    const step = stepsFor("expert")[0]!;
    const orig = window.matchMedia;
    try {
      window.matchMedia = ((q: string) => ({ matches: !q.includes("coarse") })) as unknown as typeof window.matchMedia;
      wrap(<TourOverlay step={step} index={0} total={9} onNext={() => undefined} onPrev={() => undefined} onSkip={() => undefined} />);
      expect(document.getElementById("tour-body")!.textContent).toContain("Esc 跳过");
      cleanup();
      window.matchMedia = ((q: string) => ({ matches: q.includes("coarse") })) as unknown as typeof window.matchMedia;
      wrap(<TourOverlay step={step} index={0} total={9} onNext={() => undefined} onPrev={() => undefined} onSkip={() => undefined} />);
      expect(document.getElementById("tour-body")!.textContent).not.toContain("Esc");
    } finally {
      window.matchMedia = orig;
    }
  });
  it("finishing goes back to the arena", () => {
    let h = "#/training/upload";
    returnToArena({ getHash: () => h, setHash: (x) => (h = x) });
    expect(h).toBe("#/arena");
    const setHash = vi.fn();
    returnToArena({ getHash: () => "#/arena", setHash });
    expect(setHash).not.toHaveBeenCalled();
  });
});

/* sanity: the mock admin mirrors the server (masked codes in the list, ids to revoke) */
describe("mock admin parity", () => {
  it("lists ids and masked codes", async () => {
    const a = createMockAdmin({ loggedInAs: "reviewer" });
    const inv = await a.createInvite("小李", "expert");
    expect(inv.code).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    const row = (await a.listInvites()).find((i) => i.name === "小李")!;
    expect(row.code).not.toBe(inv.code);
    await a.revokeInvite(row.id!);
    expect((await a.listInvites()).find((i) => i.id === row.id)!.revoked).toBe(true);
  });
});
