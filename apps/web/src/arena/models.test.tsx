import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createHttpBackend } from "../backend/http";
import { createMockBackend } from "../backend/mock";
import type { Backend } from "../backend/types";
import { normalizeScripts } from "../backend/normalize";
import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { EngineBadge, modelLabel, modelPriceTier, ScriptPicker } from "../pages/ArenaPage";

describe("D30 model picker", () => {
  it("price tiers and labels", () => {
    expect(modelPriceTier("glm")).toBe("cheapest");
    expect(modelPriceTier("deepseek")).toBe("cheap");
    expect(modelPriceTier("sonnet")).toBe("pricey");
    expect(modelLabel({ modelChoice: "glm", model: "z-ai/glm-5.3-flash" })).toBe("GLM 5.3 Flash");
    expect(modelLabel({ modelChoice: "sonnet", model: "custom/x" })).toBe("custom/x"); // env override shown as-is
    expect(modelLabel({ modelChoice: "haiku" })).toBe("Claude Haiku 5.5");
  });

  it("renders four options with TEE / not-TEE and price, DeepSeek default checked", () => {
    const backend = { kind: "http", readOnly: false } as unknown as Backend;
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ScriptPicker scripts={normalizeScripts([{ id: "s1", title: "S1" }])} recorded={[]} backend={backend} picked="s1" onPick={() => undefined} onStart={() => undefined} />
      </I18nProvider>,
    );
    for (const name of ["DeepSeek V4.1 Flash", "GLM 5.3 Flash", "Claude Haiku 5.5", "Claude Sonnet 5.5"]) expect(html).toContain(name);
    expect(html.match(/class="model-option on"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true" aria-label="DeepSeek[^"]*" class="model-option on"/);
    expect(html).toContain(en["arena.modelNoTee"]);
    expect(html).toContain(en["arena.modelPricey"]);
  });

  it("engine badge: model name when live, rules badge when not", () => {
    const r = (s: Parameters<typeof EngineBadge>[0]["session"]) => renderToStaticMarkup(<I18nProvider><EngineBadge session={s} /></I18nProvider>);
    expect(r({ engine: "nearai", modelChoice: "glm", model: "z-ai/glm-5.3-flash" })).toContain("GLM 5.3 Flash");
    const rules = r({ engine: "rules", modelChoice: "sonnet" });
    expect(rules).toContain(en["engine.rulesMode"]);
    expect(rules).not.toContain(">Claude Sonnet");
  });

  it("http backend sends modelChoice and reads /arena/models; mock records the choice in rules mode", async () => {
    const calls: { url: string; body?: string }[] = [];
    const b = createHttpBackend("http://x", (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      return new Response(url.endsWith("/arena/models") ? '{"default":"deepseek","liveLLM":true,"models":[]}' : '{"id":"s"}', { status: 200 });
    }) as unknown as typeof fetch);
    await b.createSession("x", { scammer: "ai", bait: "ai" }, "glm");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ scriptId: "x", scammer: "ai", bait: "ai", modelChoice: "glm" });
    await b.createSession("x", { scammer: "ai", bait: "ai" });
    expect(JSON.parse(calls[1]!.body!).modelChoice).toBeUndefined();
    expect((await b.listModels!()).default).toBe("deepseek");
    expect(calls[2]!.url).toBe("http://x/arena/models");

    const m = createMockBackend({ scripts: normalizeScripts([{ id: "m1", title: "M" }]) });
    const s = await m.createSession("m1", { scammer: "ai", bait: "ai" }, "haiku");
    expect(s).toMatchObject({ engine: "rules", modelChoice: "haiku" });
    expect((await m.listModels!()).models.every((x) => !x.available)).toBe(true);
  });

  it("zh/en both have the model strings", () => {
    for (const k of ["arena.model", "arena.modelTee", "arena.modelNoTee", "arena.modelPricey", "arena.modelBadge", "arena.modelUnavailable"] as const) {
      expect(zh[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
    }
  });
});
