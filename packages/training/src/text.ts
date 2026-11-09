import type { Lang } from "@baitnet/shared";

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/** zh if CJK characters make up a meaningful share of the letters, else en. */
export function detectLang(text: string): Lang {
  const cjk = (text.match(CJK) ?? []).length;
  const words = (text.match(LATIN_WORD) ?? []).length;
  return cjk > 0 && cjk >= words * 0.5 ? "zh" : "en";
}

const EN_STOP = new Set(
  "a an the and or but if of to in on at by for with from as is are was were be been am i you he she it we they me my your our their this that these those do does did not no yes so just can will would should could have has had what when where which who how why there here then than too very also about into out up down over please ok okay".split(
    " ",
  ),
);
const ZH_STOP = new Set(["的", "了", "吗", "呢", "吧", "啊", "呀", "哦", "嗯", "是", "我", "你", "他", "她", "们", "在", "就", "也", "都", "和", "很", "这", "那", "个"]);

/**
 * Bilingual tokenizer for keyword scoring.
 * - English / Latin: lowercased words (≥2 chars, stopwords dropped), crude plural strip.
 * - Chinese: character bigrams over each CJK run (single-char runs kept as unigrams unless stopwords).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z][a-z0-9'-]+/g)) {
    let w = m[0].replace(/'s$/, "");
    if (EN_STOP.has(w) || w.length < 2) continue;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  for (const m of text.matchAll(/[㐀-鿿豈-﫿]+/g)) {
    const run = [...m[0]];
    if (run.length === 1) {
      if (!ZH_STOP.has(run[0]!)) out.push(run[0]!);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run[i]! + run[i + 1]!);
  }
  return out;
}

/** Character-bigram Dice similarity on normalized text (works for zh and en). 1 = identical. */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const A = norm(a);
  const B = norm(b);
  if (!A && !B) return 1;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    const cs = [...s];
    for (let i = 0; i < cs.length - 1; i++) {
      const g = cs[i]! + cs[i + 1]!;
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  let total = 0;
  for (const [, v] of ga) total += v;
  for (const [, v] of gb) total += v;
  for (const [g, v] of ga) inter += Math.min(v, gb.get(g) ?? 0);
  return (2 * inter) / total;
}
