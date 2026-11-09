import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttestationResult, ScriptAnalysis } from "@baitnet/shared";
import { createHttpBackend } from "../backend/http";
import { createMockBackend } from "../backend/mock";
import { AnalysisView, isImageFile, needsSaveConfirm, uploadAccept } from "../pages/TrainingPage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { I18nProvider } from "../i18n";
import { AuthProvider } from "../auth/context";

const chat = `[2026/11/1 21:03] 王丽: 亲爱的，我舅舅有黄金内幕
[2026/11/1 21:05] 我: 怎么弄？
[2026/11/1 21:15] 王丽: 先充 300U，转到 TPqj5vZt3SBCFMh8Lo85LwBCX5CuiJrw6c 就行
[2026/11/1 21:16] 王丽: 电话 13812345678`;
const att: AttestationResult = {
  model: "m", nonce: "n", checks: [{ name: "model: nonce echoed", pass: true, detail: "" }, { name: "gateway: TDX quote parses", pass: false, detail: "x" }],
  verified: false, recorded: true, at: "2026-11-09T00:00:00Z",
};

describe("zero-retention upload (D27)", () => {
  it("http: ephemeral uses /scripts/analyze-ephemeral; saving sends the analysis back", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/scripts/analyze-ephemeral")) return new Response(JSON.stringify({ id: "an-e", ephemeral: true, attestation: att, draft: { id: "d" } }));
      return new Response(JSON.stringify({ id: "d" }));
    }) as unknown as typeof fetch;
    const b = createHttpBackend("", f);
    const a = await b.upload({ filename: "c.txt", content: chat, encoding: "utf8", expertId: "e" }, { ephemeral: true });
    expect(calls[0].url).toBe("/scripts/analyze-ephemeral");
    await b.saveScript(a.id, { id: "d" } as never, a);
    expect(calls[1]).toMatchObject({ url: "/scripts/analyses/an-e/save", body: { draft: { id: "d" }, analysis: { id: "an-e", ephemeral: true } } });
    // Normal uploads keep the old path and body.
    await b.upload({ filename: "c.txt", content: chat, encoding: "utf8", expertId: "e" });
    await b.saveScript("an-n", { id: "d" } as never);
    expect(calls[2].url).toBe("/scripts/upload");
    expect(calls[3].body).toEqual({ draft: { id: "d" } });
  });

  it("mock: nothing stored until the confirmed save; screenshots rejected", async () => {
    const b = createMockBackend({ scripts: [], attestation: { ...att, recorded: false } });
    const a = await b.upload({ filename: "c.txt", content: chat, encoding: "utf8", expertId: "e" }, { ephemeral: true });
    expect(a.ephemeral).toBe(true);
    expect(a.attestation?.recorded).toBe(true);
    await expect(b.saveScript(a.id, a.draft)).rejects.toThrow(/unknown analysis/);
    await b.saveScript(a.id, a.draft, a);
    expect((await b.listScripts()).map((s) => s.id)).toContain(a.draft.id);
    await expect(b.upload({ filename: "s.png", content: "AAAA", encoding: "base64", expertId: "e" }, { ephemeral: true })).rejects.toThrow("ephemeral-image");
  });

  it("file picker excludes images when the switch is on", () => {
    expect(uploadAccept(true)).not.toMatch(/image|png|jpe?g/);
    expect(uploadAccept(false)).toMatch(/image\/\*/);
    expect(isImageFile({ name: "IMG_0001.HEIC" })).toBe(true);
    expect(isImageFile({ name: "x.bin", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "chat.txt", type: "text/plain" })).toBe(false);
  });

  it("result page: banner, attestation panel (recorded sample), no review before saving, save needs confirm", async () => {
    const b = createMockBackend({ scripts: [], attestation: att });
    const a = (await b.upload({ filename: "c.txt", content: chat, encoding: "utf8", expertId: "e" }, { ephemeral: true })) as ScriptAnalysis;
    expect(needsSaveConfirm(a)).toBe(true);
    expect(needsSaveConfirm({ ...a, ephemeral: undefined })).toBe(false);
    const html = renderToStaticMarkup(
      <I18nProvider lang="zh">
        <AuthProvider apiBase={null} ready initialState={{ kind: "disabled" }}>
          <AnalysisView a={a} backend={b} network="testnet" expert="e" />
        </AuthProvider>
      </I18nProvider>,
    );
    expect(html).toContain("零留存：服务器未保存任何内容");
    expect(html).toContain("录制样例");
    expect(html).toContain("模型：回显了本次 nonce");
    expect(html).toContain("未通过");
    expect(html).toContain("保存之后才能复核");
    expect(html).not.toContain("复核通过，上链");
  });

  it("confirm dialog text in both languages", () => {
    for (const [lang, text] of [["zh", "保存后会写入服务器，确定吗？"], ["en", "Saving will write to the server. Continue?"]] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider lang={lang}>
          <ConfirmDialog open title={text} confirmLabel="ok" cancelLabel="cancel" onConfirm={() => undefined} onCancel={() => undefined} />
        </I18nProvider>,
      );
      expect(html).toContain('role="alertdialog"');
      expect(html).toContain(text);
    }
    expect(renderToStaticMarkup(<ConfirmDialog open={false} title="x" confirmLabel="a" cancelLabel="b" onConfirm={() => undefined} onCancel={() => undefined} />)).toBe("");
  });
});
