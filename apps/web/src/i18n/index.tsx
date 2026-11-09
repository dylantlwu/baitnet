import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type MsgKey } from "./en";
import { zh } from "./zh";
import { setFormatLocale } from "../lib/format";

export type UiLang = "zh" | "en";
export const DICTS: Record<UiLang, Record<MsgKey, string>> = { en, zh };
const STORE_KEY = "baitnet.lang";

/** zh is the first-class language: anything that is not explicitly English falls back to Chinese. */
export function detectLang(stored: string | null, navLangs: readonly string[]): UiLang {
  if (stored === "zh" || stored === "en") return stored;
  for (const l of navLangs) {
    const p = l.toLowerCase();
    if (p.startsWith("zh")) return "zh";
    if (p.startsWith("en")) return "en";
  }
  return "zh";
}

export function readStoredLang(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}
function writeStoredLang(l: UiLang) {
  try {
    localStorage.setItem(STORE_KEY, l);
  } catch {
    /* private mode etc. */
  }
}

export type Vars = Record<string, string | number>;
export type TFn = (key: MsgKey, vars?: Vars) => string;

/** Translate with {var} interpolation; a numeric `n` picks `<key>_one` when n === 1 and that key exists. */
export function translate(lang: UiLang, key: MsgKey, vars?: Vars): string {
  const d = DICTS[lang];
  let k: MsgKey = key;
  if (vars && typeof vars.n === "number" && vars.n === 1 && `${key}_one` in d) k = `${key}_one` as MsgKey;
  const s = d[k] ?? en[k] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : s;
}

/** Loose lookup for enum-ish values coming from the backend (e.g. "tag.stalling"); falls back to the raw value. */
export function translateLoose(lang: UiLang, key: string, fallback: string): string {
  return key in DICTS[lang] ? DICTS[lang][key as MsgKey] : fallback;
}

interface Ctx {
  lang: UiLang;
  setLang: (l: UiLang) => void;
  t: TFn;
  /** tl("tag", "stalling") -> dict["tag.stalling"] ?? "stalling" */
  tl: (prefix: string, value: string) => string;
}
const I18nCtx = createContext<Ctx>({
  lang: "zh",
  setLang: () => undefined,
  t: (k, v) => translate("zh", k, v),
  tl: (p, v) => translateLoose("zh", `${p}.${v}`, v),
});

export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: UiLang }) {
  const [lang, setLangState] = useState<UiLang>(
    () => forced ?? detectLang(readStoredLang(), typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []),
  );
  setFormatLocale(lang);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = translate(lang, "app.title");
  }, [lang]);
  const setLang = useCallback((l: UiLang) => {
    writeStoredLang(l);
    setLangState(l);
  }, []);
  const value = useMemo<Ctx>(
    () => ({ lang, setLang, t: (k, v) => translate(lang, k, v), tl: (p, v) => translateLoose(lang, `${p}.${v}`, v) }),
    [lang, setLang],
  );
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
export const useT = () => useContext(I18nCtx).t;
export type { MsgKey };
