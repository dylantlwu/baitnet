import type { Lang } from "@baitnet/shared";

/** Language of a message: Chinese if it has a meaningful share of CJK characters. */
export function detectLang(text: string, fallback: Lang = "en"): Lang {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (cjk === 0 && latin === 0) return fallback;
  return cjk >= 4 || cjk > latin ? "zh" : "en";
}

/** Deterministic PRNG (mulberry32) so a session is varied but replayable. */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a variant, avoiding the ones used recently. */
export function pick<T>(items: T[], rand: () => number, recent: T[] = []): T {
  const fresh = items.filter((x) => !recent.includes(x));
  const pool = fresh.length ? fresh : items;
  return pool[Math.floor(rand() * pool.length)]!;
}

export const CHAIN_NAME: Record<Lang, Record<string, string>> = {
  zh: { near: "NEAR 链", evm: "以太坊（ERC20）", tron: "波场（TRC20）", btc: "比特币" },
  en: { near: "NEAR", evm: "Ethereum (ERC-20)", tron: "Tron (TRC-20)", btc: "Bitcoin" },
};

/** Chain names a non-technical persona would say (no "TRC20"/"ERC20" jargon, D32 knowledge-leak). */
export const PLAIN_CHAIN_NAME: Record<Lang, Record<string, string>> = {
  zh: { near: "NEAR 链", evm: "以太坊", tron: "波场", btc: "比特币" },
  en: { near: "NEAR", evm: "Ethereum", tron: "Tron", btc: "Bitcoin" },
};
