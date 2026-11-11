// @vitest-environment jsdom
/**
 * D33 防混淆检查: warnings under a pending draft, per-warning confirm before approve, confirmWarnings on the wire,
 * and the mock mirroring the server's 409.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AlertDraft, ArenaSession, Me, ScamScriptDef } from "@baitnet/shared";
import { AuthProvider } from "./auth/context";
import { I18nProvider } from "./i18n";
import { zh } from "./i18n/zh";
import { en } from "./i18n/en";
import { StaticBackendProvider } from "./backend/context";
import { createHttpBackend, HttpError } from "./backend/http";
import { createMockBackend, mockDraftWarnings } from "./backend/mock";
import { DraftItem, draftWarnings, reviewErrorText } from "./pages/ArenaPage";

afterEach(cleanup);

const reviewer: Me = { authEnabled: true, expertId: "u_r1", name: "Dylan", role: "reviewer", llmQuota: { usedToday: 0, limitPerDay: 100 } };

function wrap(ui: React.ReactNode, lang: "zh" | "en" = "zh") {
  return render(
    <I18nProvider lang={lang}>
      <AuthProvider apiBase={null} ready={false} initialState={{ kind: "user", me: reviewer }} onLoggedOut={() => undefined}>
        <StaticBackendProvider backend={null}>{ui}</StaticBackendProvider>
      </AuthProvider>
    </I18nProvider>,
  );
}

type Row = ArenaSession["drafts"][number];
const base: Row = { chain: "evm", address: "0x" + "cd".repeat(20), level: "L1", category: "investment", evidenceHash: "", conversationId: "s", review: "pending" };
const warned: Row = {
  ...base,
  warnings: [
    { code: "suspicion-before", detail: "对方第 3 句问「你是不是机器人」" },
    { code: "chain-mismatch", detail: "说的是 TRC20，给的却是 0x 地址" },
  ],
};

describe("D33 draft warnings: card", () => {
  it("lists every warning with its label and detail under a pending draft", () => {
    wrap(<ul><DraftItem d={warned} i={0} network="testnet" readOnly={false} busy={false} onReview={() => undefined} /></ul>);
    const list = screen.getByRole("list", { name: /通过前请核实/ });
    expect(list.textContent).toContain(zh["draftWarn.suspicion-before"]);
    expect(list.textContent).toContain("你是不是机器人");
    expect(list.textContent).toContain(zh["draftWarn.chain-mismatch"]);
    expect(list.textContent).toContain("TRC20");
  });

  it("english labels", () => {
    wrap(<ul><DraftItem d={{ ...base, warnings: [{ code: "contract", detail: "has code" }] }} i={0} network="testnet" readOnly={false} busy={false} onReview={() => undefined} /></ul>, "en");
    expect(screen.getByText(en["draftWarn.contract"])).toBeTruthy();
  });

  it("no warning list once the draft is decided, nor for a filtered one", () => {
    wrap(<ul><DraftItem d={{ ...warned, review: "rejected" }} i={0} network="testnet" readOnly={false} busy={false} onReview={() => undefined} /></ul>);
    expect(screen.queryByText(zh["draftWarn.chain-mismatch"])).toBeNull();
    expect(draftWarnings({ ...warned, filteredReason: "known entity" })).toEqual([]);
    expect(draftWarnings(base)).toEqual([]);
  });

  it("approve stays disabled until every warning is ticked, then sends confirmWarnings", () => {
    const onReview = vi.fn();
    wrap(<ul><DraftItem d={warned} i={2} network="testnet" readOnly={false} busy={false} onReview={onReview} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "复核通过，上链" }));
    const yes = screen.getByRole("button", { name: "确认上链" }) as HTMLButtonElement;
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(yes.disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    expect(yes.disabled).toBe(true);
    fireEvent.click(yes);
    expect(onReview).not.toHaveBeenCalled();
    fireEvent.click(boxes[1]!);
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    expect(onReview).toHaveBeenCalledWith(2, true, true);
  });

  it("ticks reset when the confirm is reopened", () => {
    wrap(<ul><DraftItem d={warned} i={0} network="testnet" readOnly={false} busy={false} onReview={() => undefined} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "复核通过，上链" }));
    screen.getAllByRole("checkbox").forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "复核通过，上链" }));
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).every((b) => !b.checked)).toBe(true);
    expect((screen.getByRole("button", { name: "确认上链" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a 409 becomes a plain message", () => {
    const t = (k: string) => zh[k as keyof typeof zh];
    expect(reviewErrorText(new HttpError(409, "confirm warnings first"), t)).toBe(zh["draftWarn.conflict"]);
    expect(reviewErrorText(new Error("boom"), t)).toBe("boom");
  });
});

describe("D33 draft warnings: backends", () => {
  function recordingFetch() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response("{}");
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  it("http: confirmWarnings is sent only when confirmed (arena + upload)", async () => {
    const { calls, f } = recordingFetch();
    const b = createHttpBackend("http://x", f);
    await b.review("s1", 0, true, true);
    await b.review("s1", 1, true);
    await b.reviewUploadDraft("an-1", 0, true, true);
    expect(calls[0]!.body).toEqual({ draftIndex: 0, approve: true, confirmWarnings: true });
    expect(calls[1]!.body).toEqual({ draftIndex: 1, approve: true });
    expect(calls[2]!.body).toEqual({ draftIndex: 0, approve: true, confirmWarnings: true });
  });

  it("http: a 409 keeps status and body", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "warnings-unconfirmed", warnings: ["contract"] }), { status: 409 })) as unknown as typeof fetch;
    const err = await createHttpBackend("http://x", f).review("s1", 0, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).body).toMatchObject({ warnings: ["contract"] });
  });

  it("mock: 409 without the flag, approved with it; reject needs no flag", async () => {
    const session: ArenaSession = {
      id: "as-w", scriptId: "x", status: "finished", modes: { scammer: "ai", bait: "ai" }, turns: [], createdAt: "2026-11-11T00:00:00Z",
      drafts: [warned, { ...warned }],
    } as unknown as ArenaSession;
    const b = createMockBackend({ scripts: [], sessions: [session] }, { tickMs: 1 });
    const err = await b.review("as-w", 0, true).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(409);
    await expect(b.review("as-w", 0, true, true)).resolves.toBeUndefined();
    await expect(b.review("as-w", 1, false)).resolves.toBeUndefined();
  });

  it("mock: live drafts get suspicion-before and chain-mismatch", () => {
    const w = mockDraftWarnings(["Hi", "Are you a bot?"], "send via TRC20 to 0x" + "ab".repeat(20), "evm", "en");
    expect(w.map((x) => x.code)).toEqual(["suspicion-before", "chain-mismatch"]);
    expect(w[0]!.detail).toContain("line 2");
    expect(mockDraftWarnings(["你好"], "转到以太坊 0x" + "ab".repeat(20), "evm", "zh")).toEqual([]);
    expect(mockDraftWarnings(["你是不是机器人？"], "TRC20 地址 T...", "tron", "zh").map((x) => x.code)).toEqual(["suspicion-before"]);
  });

  it("mock: upload drafts with warnings need the flag too", async () => {
    const b = createMockBackend({ scripts: [] as ScamScriptDef[] });
    const addr = "0x" + "ef".repeat(20);
    const a = await b.upload({ filename: "c.txt", content: `骗子: 你是不是机器人？\n我: 不是啊\n骗子: 用 TRC20 转到 ${addr}\n我: 好`, encoding: "utf8", expertId: "e" });
    const d: AlertDraft = a.alertDrafts[0]!;
    expect(draftWarnings(d).map((w) => w.code)).toEqual(["suspicion-before", "chain-mismatch"]);
    const err = await b.reviewUploadDraft(a.id, 0, true).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(409);
    expect((await b.reviewUploadDraft(a.id, 0, true, true)).alertId).toBeGreaterThan(0);
  });
});
