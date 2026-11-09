import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArenaSession, ArenaTurn } from "@baitnet/shared";
import { arenaReducer, initialArena, type ArenaAction, type ArenaState } from "./reducer";
import { sendSay } from "./optimistic";
import { normalizeScripts } from "../backend/normalize";
import { createHttpBackend } from "../backend/http";
import { createMockBackend } from "../backend/mock";
import type { Backend } from "../backend/types";
import { I18nProvider } from "../i18n";
import { ScriptPicker } from "../pages/ArenaPage";

const session: ArenaSession = {
  id: "s1", scriptId: "x", engine: "rules", modes: { scammer: "human", bait: "ai" }, status: "paused", turns: [], drafts: [], createdAt: "t",
};
const humanTurn = (index: number, text: string): ArenaTurn => ({ index, side: "scammer", text, author: "human", ts: "t" });

function store() {
  let st: ArenaState = arenaReducer(initialArena, { type: "session", session });
  const dispatch = (a: ArenaAction) => {
    st = arenaReducer(st, a);
  };
  return { get: () => st, dispatch };
}

describe("optimistic say", () => {
  it("shows the line immediately as sending, then the server turn replaces it", async () => {
    const s = store();
    let resolve!: (t: ArenaTurn) => void;
    const backend = { say: vi.fn(() => new Promise<ArenaTurn>((r) => (resolve = r))) };
    const done = sendSay(backend, "s1", "scammer", "Send it to my wallet", s.dispatch);
    expect(s.get().pending).toEqual([expect.objectContaining({ side: "scammer", text: "Send it to my wallet", status: "sending" })]);
    expect(s.get().session!.turns).toHaveLength(0);
    resolve(humanTurn(0, "Send it to my wallet"));
    await done;
    expect(s.get().pending).toHaveLength(0);
    expect(s.get().session!.turns).toHaveLength(1);
  });

  it("dedupes by index when the SSE turn arrives after the HTTP response (and vice versa)", async () => {
    const s = store();
    await sendSay({ say: async () => humanTurn(0, "hello") }, "s1", "scammer", "hello", s.dispatch);
    s.dispatch({ type: "event", event: { type: "turn", sessionId: "s1", turn: humanTurn(0, "hello") } });
    expect(s.get().session!.turns).toHaveLength(1);
    expect(s.get().pending).toHaveLength(0);

    // SSE first, HTTP returns nothing
    const s2 = store();
    const p = sendSay({ say: async () => undefined }, "s1", "scammer", "  spaced   text ", s2.dispatch);
    s2.dispatch({ type: "event", event: { type: "turn", sessionId: "s1", turn: humanTurn(0, "spaced text") } });
    await p;
    expect(s2.get().pending).toHaveLength(0);
    expect(s2.get().session!.turns).toHaveLength(1);
  });

  it("two identical lines: each confirmation removes only one optimistic copy", () => {
    const s = store();
    s.dispatch({ type: "sayStart", pending: { localId: "a", side: "scammer", text: "ok", ts: "t" } });
    s.dispatch({ type: "sayStart", pending: { localId: "b", side: "scammer", text: "ok", ts: "t" } });
    s.dispatch({ type: "event", event: { type: "turn", sessionId: "s1", turn: humanTurn(0, "ok") } });
    expect(s.get().pending.map((p) => p.localId)).toEqual(["b"]);
    // An AI turn with the same text must not consume the human's pending line.
    s.dispatch({ type: "event", event: { type: "turn", sessionId: "s1", turn: { ...humanTurn(1, "ok"), author: "ai" } } });
    expect(s.get().pending.map((p) => p.localId)).toEqual(["b"]);
  });

  it("marks the line failed and retry re-sends the same localId", async () => {
    const s = store();
    const say = vi.fn().mockRejectedValueOnce(new Error("HTTP 502")).mockResolvedValueOnce(humanTurn(0, "hi"));
    expect(await sendSay({ say }, "s1", "scammer", "hi", s.dispatch)).toBe(false);
    const [p] = s.get().pending;
    expect(p).toMatchObject({ status: "failed", error: "HTTP 502" });
    const retry = sendSay({ say }, "s1", "scammer", "hi", s.dispatch, p.localId);
    expect(s.get().pending[0]).toMatchObject({ localId: p.localId, status: "sending" });
    expect(await retry).toBe(true);
    expect(s.get().pending).toHaveLength(0);
    expect(s.get().session!.turns).toHaveLength(1);
    expect(say).toHaveBeenCalledTimes(2);
  });

  it("discard removes a failed line", () => {
    const s = store();
    s.dispatch({ type: "sayStart", pending: { localId: "a", side: "bait", text: "x", ts: "t" } });
    s.dispatch({ type: "sayFailed", localId: "a", error: "e" });
    s.dispatch({ type: "sayDiscard", localId: "a" });
    expect(s.get().pending).toEqual([]);
  });

  it("works end-to-end with the mock backend (say returns the turn, event also fires)", async () => {
    const script = normalizeScripts([{ id: "x", type: "investment", lang: "en", hook: "hi", stages: [{ name: "a", sampleLines: ["l"] }] }])[0];
    const b = createMockBackend({ scripts: [script] });
    const created = await b.createSession("x", { scammer: "human", bait: "ai" });
    let st: ArenaState = arenaReducer(initialArena, { type: "session", session: created });
    const dispatch = (a: ArenaAction) => (st = arenaReducer(st, a));
    b.subscribe(created.id, (event) => dispatch({ type: "event", event }));
    await sendSay(b, created.id, "scammer", "Pay me in USDT", dispatch);
    expect(st.session!.turns).toHaveLength(1);
    expect(st.pending).toHaveLength(0);
  });
});

describe("script list robustness (old 'ScriptPicker … reading map' crash)", () => {
  it("normalizeScripts tolerates any shape", () => {
    expect(normalizeScripts(undefined)).toEqual([]);
    expect(normalizeScripts(null)).toEqual([]);
    expect(normalizeScripts({})).toEqual([]);
    expect(normalizeScripts("nope")).toEqual([]);
    const [s] = normalizeScripts([null, 3, { title: "no id" }, { id: "half", stages: null, injections: "x" }]);
    expect(s).toMatchObject({ id: "half", title: "half", stages: [], injections: [], plantedArtifacts: [], objections: [], source: "original", lang: "zh" });
  });

  it("http listScripts returns [] for empty / odd payloads and rejects on HTTP errors", async () => {
    const mk = (status: number, body: string) =>
      createHttpBackend("http://x", (async () => new Response(body, { status })) as unknown as typeof fetch);
    expect(await mk(200, "[]").listScripts()).toEqual([]);
    expect(await mk(200, "{}").listScripts()).toEqual([]);
    expect(await mk(200, '{"scripts":null}').listScripts()).toEqual([]);
    expect(await mk(200, "").listScripts()).toEqual([]);
    expect((await mk(200, '{"scripts":[{"id":"a"}]}').listScripts())[0].stages).toEqual([]);
    await expect(mk(500, '{"error":"boom"}').listScripts()).rejects.toThrow("boom");
  });

  const fakeBackend = { kind: "http", readOnly: false } as unknown as Backend;
  const render = (scripts: Parameters<typeof ScriptPicker>[0]["scripts"], picked: string | null = null) =>
    renderToStaticMarkup(
      <I18nProvider>
        <ScriptPicker scripts={scripts} recorded={[]} backend={fakeBackend} picked={picked} onPick={() => undefined} onStart={() => undefined} />
      </I18nProvider>,
    );

  it("ScriptPicker renders an empty list without crashing", () => {
    expect(render([])).toContain("empty");
  });

  it("ScriptPicker renders a half-filled script (after normalisation) without crashing", () => {
    const html = render(normalizeScripts([{ id: "half" }]), "half");
    expect(html).toContain("half");
  });

  it("ScriptPicker survives raw non-normalised input too", () => {
    expect(() => render(undefined as never)).not.toThrow();
    expect(() => render([{ id: "raw" } as never], "raw")).not.toThrow();
  });
});
