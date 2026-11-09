import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArenaSession, Correction, Me } from "@baitnet/shared";
import { createHttpAdmin, createMockAdmin, loginUrlFor, meToState, type AuthState } from "./api";
import { AuthProvider } from "./context";
import { I18nProvider } from "../i18n";
import { DraftItem } from "../pages/ArenaPage";
import { CorrectionCard } from "../pages/TrainingPage";
import { InviteResult } from "../pages/TeamPage";
import { LoginPage } from "../pages/LoginPage";
import { qrMatrix } from "../components/QrCode";
import { channelOf, playsOf } from "../pages/SessionsPage";
import type { Backend } from "../backend/types";

const reviewer: Me = { authEnabled: true, expertId: "u1", name: "Dylan", role: "reviewer", llmQuota: { usedToday: 3, limitPerDay: 100 } };
const expert: Me = { ...reviewer, expertId: "u2", name: "老周", role: "expert" };

describe("auth state from /auth/me", () => {
  it("maps responses to disabled / anonymous / user", () => {
    expect(meToState(404, { error: "not found" })).toEqual({ kind: "disabled" });
    expect(meToState(200, { authEnabled: false, expertId: "local-expert", name: "", role: "reviewer" })).toEqual({ kind: "disabled" });
    expect(meToState(401, { error: "login" })).toEqual({ kind: "anonymous" });
    expect(meToState(200, reviewer)).toEqual({ kind: "user", me: reviewer });
  });

  it("http admin: backend without auth routes (or SPA html) = disabled; sends credentials", async () => {
    const calls: RequestInit[] = [];
    const html = (async (_u: string, init?: RequestInit) => (calls.push(init ?? {}), new Response("<!doctype html>"))) as unknown as typeof fetch;
    expect(await createHttpAdmin("", html).me()).toEqual({ kind: "disabled" });
    expect(calls[0].credentials).toBe("include");
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await createHttpAdmin("", down).me()).toEqual({ kind: "disabled" });
  });

  it("http admin: login posts the code with credentials and relative path", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/auth/login");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "BN-1" });
      return new Response(JSON.stringify(reviewer));
    }) as unknown as typeof fetch;
    expect(await createHttpAdmin("", f).login("  BN-1 ")).toEqual(reviewer);
    const bad = (async () => new Response(JSON.stringify({ error: "invalid code" }), { status: 401 })) as unknown as typeof fetch;
    await expect(createHttpAdmin("", bad).login("x")).rejects.toMatchObject({ status: 401 });
  });

  it("mock admin: login flow, reviewer-only admin calls, invites carry both links", async () => {
    const a = createMockAdmin();
    expect(await a.me()).toEqual({ kind: "anonymous" });
    await expect(a.login("nope")).rejects.toMatchObject({ status: 401 });
    expect((await a.login("demo-expert")).role).toBe("expert");
    await expect(a.listInvites()).rejects.toMatchObject({ status: 403 });
    expect((await a.login("DEMO-REVIEW")).role).toBe("reviewer");
    const inv = await a.createInvite("小王", "expert");
    expect(inv.telegramStartUrl).toMatch(/^https:\/\/t\.me\/.+\?start=/);
    expect(loginUrlFor(inv, "https://bn.example")).toBe(`https://bn.example/#/login?code=${encodeURIComponent(inv.code)}`);
    expect((await a.listUsers()).some((u) => u.name === "小王")).toBe(true);
    const open = (await a.listInvites()).find((i) => !i.usedAt && !i.revoked)!;
    await a.revokeInvite(open.code);
    expect((await a.listInvites()).find((i) => i.code === open.code)?.revoked).toBe(true);
    await a.logout();
    expect(await a.me()).toEqual({ kind: "anonymous" });
  });
});

const wrap = (state: AuthState, node: React.ReactNode) =>
  renderToStaticMarkup(
    <I18nProvider lang="zh">
      <AuthProvider apiBase={null} ready initialState={state}>
        {node}
      </AuthProvider>
    </I18nProvider>,
  );

const draft = { chain: "evm" as const, address: "0x" + "ab".repeat(20), level: "L1" as const, category: "investment", evidenceHash: "", conversationId: "s", review: "pending" as const };
const corr: Correction = {
  id: "c1", sessionId: "s", turnIndex: 1, expertId: "Mia", scriptId: "x", scamType: "investment", stage: 0, situation: "", badReply: "bad", goodReply: "good", rationale: "", tags: [], review: "pending", at: "2026-11-09T00:00:00Z",
};
const backend = { readOnly: false } as unknown as Backend;

describe("role-based display", () => {
  it("experts see 'waiting for a reviewer' instead of publish / approve buttons", () => {
    const html = wrap({ kind: "user", me: expert }, (
      <>
        <DraftItem d={draft} i={0} network="testnet" readOnly={false} busy={false} onReview={() => undefined} />
        <CorrectionCard c={corr} backend={backend} reviewer="老周" onDone={() => undefined} />
      </>
    ));
    expect(html).toContain("等审核者处理");
    expect(html).not.toContain("复核通过，上链");
    expect(html).not.toContain(">通过<");
  });

  it("reviewers (and local mode) get the buttons", () => {
    for (const state of [{ kind: "user", me: reviewer } as AuthState, { kind: "disabled" } as AuthState]) {
      const html = wrap(state, <DraftItem d={draft} i={0} network="testnet" readOnly={false} busy={false} onReview={() => undefined} />);
      expect(html).toContain("复核通过，上链");
    }
  });

  it("a reviewer cannot approve their own rewrite", () => {
    const html = wrap({ kind: "user", me: reviewer }, <CorrectionCard c={{ ...corr, expertId: "Dylan" }} backend={backend} reviewer="Dylan" onDone={() => undefined} />);
    expect(html).toContain("需要由其他审核者处理");
  });

  it("login page: shows the code form when anonymous, local-mode note when disabled", () => {
    expect(wrap({ kind: "anonymous" }, <LoginPage />)).toContain("邀请码");
    expect(wrap({ kind: "disabled" }, <LoginPage />)).toContain("没有启用登录");
    expect(wrap({ kind: "user", me: reviewer }, <LoginPage />)).toContain("已登录：Dylan（审核者）");
  });

  it("invite result renders two QR codes (Telegram + web login)", () => {
    const html = wrap({ kind: "user", me: reviewer }, (
      <InviteResult inv={{ code: "BN-1", name: "小王", role: "expert", createdBy: "Dylan", createdAt: "t", telegramStartUrl: "https://t.me/Bot?start=BN-1", loginUrl: "https://bn/#/login?code=BN-1" }} />
    ));
    expect(html.match(/<svg class="qr"/g)).toHaveLength(2);
    expect(html).toContain("https://t.me/Bot?start=BN-1");
    expect(html).toContain("https://bn/#/login?code=BN-1");
  });
});

describe("helpers", () => {
  it("QR matrix is square and non-trivial", () => {
    const m = qrMatrix("https://t.me/BaitNetTrainerBot?start=BN-0001-ABCD");
    expect(m.length).toBeGreaterThan(20);
    expect(m.every((r) => r.length === m.length)).toBe(true);
    expect(m.flat().some(Boolean)).toBe(true);
  });

  it("session channel and who plays which side", () => {
    const base = { modes: { scammer: "ai", bait: "ai" } } as ArenaSession;
    expect(channelOf(base)).toBe("web");
    expect(playsOf(base)).toBe("observer");
    expect(playsOf({ ...base, modes: { scammer: "human", bait: "ai" } })).toBe("scammer");
    const tg = { ...base, channel: { kind: "telegram" as const, ownerId: "u", expertPlays: "bait" as const } };
    expect(channelOf(tg)).toBe("telegram");
    expect(playsOf(tg)).toBe("bait");
  });
});
