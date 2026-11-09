import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zh } from "./zh";
import { detectLang, translate } from "./index";

describe("i18n dictionaries", () => {
  it("zh and en have exactly the same key set", () => {
    const a = Object.keys(en).sort();
    const b = Object.keys(zh).sort();
    expect(b.filter((k) => !a.includes(k))).toEqual([]);
    expect(a.filter((k) => !b.includes(k))).toEqual([]);
  });

  it("no empty strings, and placeholders match between languages", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[k].trim(), k).not.toBe("");
      expect(zh[k].trim(), k).not.toBe("");
      expect(vars(zh[k]), k).toEqual(vars(en[k]));
    }
  });

  it("every static t(\"…\") key used in the source exists", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !f.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(root);
    const missing: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/\b(?:t|tr)\("([a-zA-Z0-9_.+-]+)"/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("Chinese is the default unless the browser explicitly prefers English", () => {
    expect(detectLang(null, ["zh-CN"])).toBe("zh");
    expect(detectLang(null, ["en-US", "zh-CN"])).toBe("en");
    expect(detectLang(null, ["fr-FR", "de"])).toBe("zh");
    expect(detectLang(null, [])).toBe("zh");
    expect(detectLang("en", ["zh-CN"])).toBe("en");
    expect(detectLang("garbage", ["ja"])).toBe("zh");
  });

  it("interpolates and picks _one forms", () => {
    expect(translate("en", "alerts.guardHits", { n: 1 })).toBe("1 guard hit");
    expect(translate("en", "alerts.guardHits", { n: 3 })).toBe("3 guard hits");
    expect(translate("zh", "arena.onChainAs", { id: 7 })).toBe("已上链，警报 #7");
  });

  it("uses the agreed Chinese terminology", () => {
    expect(zh["side.bait"]).toBe("诱饵");
    expect(zh["side.scammer"]).toBe("骗子");
    expect(zh["mode.human"]).toBe("接管");
    expect(zh["arena.whisper"]).toBe("耳语");
    expect(zh["nav.eval"]).toBe("成绩单");
    expect(zh["arena.approve"]).toContain("复核");
    expect(zh["arena.approve"]).toContain("上链");
  });
});
