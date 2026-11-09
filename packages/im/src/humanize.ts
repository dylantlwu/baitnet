/**
 * "Feels like a person": typing pause 2–8 s depending on length, and long
 * replies sometimes arrive as two messages.
 * BAITNET_IM_DELAY_SCALE scales the pause (0 = no pause, used by tests; 0.3 for quick local demos).
 */

export function delayScale(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.BAITNET_IM_DELAY_SCALE ?? 1);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** 2 s + ~60 ms per character (CJK counts double: it is typed slower), capped at 8 s. */
export function typingDelayMs(text: string, scale = 1, random: () => number = Math.random): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const weight = text.length + cjk;
  const base = 2000 + weight * 60 + random() * 800;
  return Math.round(Math.min(8000, Math.max(2000, base)) * scale);
}

/**
 * Split a long reply into two natural parts at a sentence boundary near the middle
 * (only sometimes, only when long enough). Returns [text] when not split.
 */
export function maybeSplit(text: string, random: () => number = Math.random, minLen = 40, chance = 0.45): string[] {
  const t = text.trim();
  if (t.length < minLen || random() >= chance) return [t];
  if (/^\s*[-*•]|\n\s*[-*•\d]/.test(t)) return [t]; // lists stay intact
  const re = /[。！？!?；;…]+["”』」）)]?\s*|\.\s+|\n+/g;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) if (m.index + m[0].length < t.length) cuts.push(m.index + m[0].length);
  if (!cuts.length) return [t];
  const mid = t.length / 2;
  const cut = cuts.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  const a = t.slice(0, cut).trim();
  const b = t.slice(cut).trim();
  // never break a payment address / URL across messages, never leave a tiny tail
  if (a.length < 8 || b.length < 8) return [t];
  return [a, b];
}
