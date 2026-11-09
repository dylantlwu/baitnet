import type { Chain, Conversation } from "@baitnet/shared";
import { isValidNearAccount } from "@baitnet/guard";

export interface ExtractedAddress {
  chain: Chain;
  address: string;
  /** Asset/network hint from the surrounding text (rule-based; LLM may refine). */
  assetHint?: string;
  turnIndex: number;
  context: string;
}

export interface Extraction {
  addresses: ExtractedAddress[];
  urls: string[];
  /** PII: only ever goes into encrypted evidence. */
  phones: string[];
  telegrams: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'，。）)]+/gi;
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const TRON_RE = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g;
const BTC_BECH32_RE = /\b(?:bc1|tb1)[02-9ac-hj-np-z]{11,71}\b/gi;
const BTC_LEGACY_RE = /\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b/g;
// named NEAR accounts ending in .near / .testnet (incl. sandbox *.test.near); not followed by more domain labels
const NEAR_RE = /(?<![\w.@-])(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+(?:near|testnet)(?![\w-]|\.[a-z0-9])/gi;
const PHONE_RE = /(?<![\w+])(?:\+\d{1,3}(?:[ -]?\d){6,14}|1[3-9]\d(?:[ -]?\d){8})(?!\d)/g;
const TG_RE = /(?<![\w.])@[A-Za-z][A-Za-z0-9_]{4,31}\b|(?<=(?:微信|VX|vx|WeChat|wechat)(?:号)?\s*[:：]?\s*)[A-Za-z][A-Za-z0-9_-]{5,19}\b/g;

const ASSET_HINTS: [RegExp, string][] = [
  [/TRC-?20|波场/i, "USDT-TRC20"],
  [/ERC-?20|以太坊|以太/i, "ERC-20"],
  [/BEP-?20|BSC|币安链|币安智能链/i, "BEP-20"],
  [/USDT|泰达|U币|\d\s*[uU](?![a-zA-Z])/i, "USDT"],
  [/USDC/i, "USDC"],
  [/\bBTC\b|bitcoin|比特币|大饼/i, "BTC"],
  [/\bNEAR\b|NEAR链|near 链/i, "NEAR"],
];

/**
 * Chinese chat normalization: full-width letters/digits/punctuation → ASCII
 * (NFKC), ideographic space → space, zero-width chars removed.
 */
export function normalizeChatText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u3000/g, " ");
}

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const SPLIT_SEP = "[ \\t\\r\\n\\-_·,，、]+";
/**
 * Re-join addresses that were split by spaces / line breaks / dashes
 * ("TKsN etrAE YeSL…", "0x2209 54f5 …"), and colloquial "T开头…后面是 xxx".
 * Only accepts a join whose concatenation is exactly a valid address.
 */
export function joinSplitAddresses(text: string): string[] {
  const out: string[] = [];
  const tryChunks = (chunks: string[], valid: (s: string) => boolean, maxLen: number) => {
    let acc = "";
    for (let i = 0; i < chunks.length; i++) {
      acc += chunks[i];
      if (acc.length > maxLen) break;
      if (i > 0 && valid(acc)) out.push(acc);
    }
  };
  const runRe = new RegExp(`(?:0x|0X|T|bc1|BC1)[0-9A-Za-z]*(?:${SPLIT_SEP}[0-9A-Za-z]+){1,12}`, "g");
  for (const m of text.matchAll(runRe)) {
    const chunks = m[0].split(new RegExp(SPLIT_SEP));
    tryChunks(chunks, (s) => /^0x[0-9a-fA-F]{40}$/i.test(s), 42);
    tryChunks(chunks, (s) => new RegExp(`^T${B58}{33}$`).test(s), 34);
    tryChunks(chunks, (s) => /^bc1[02-9ac-hj-np-z]{11,71}$/i.test(s) && s.length >= 42, 62);
  }
  // "T开头，后面是 KsNetr…" / "以 T 开头的地址：KsNetr…"
  const colloq = new RegExp(`(?:以\\s*)?([T])\\s*开头[^\\n]{0,12}?(?:后面|后边|接着|是|：|:)\\s*(${B58}{33})(?!${B58})`, "g");
  for (const m of text.matchAll(colloq)) out.push(m[1] + m[2]);
  return [...new Set(out)];
}

/** Classify a bare address string by format (used by solver/trace too). */
export function detectChain(addr: string): Chain | undefined {
  const a = addr.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "evm";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return "tron";
  if (/^(bc1|tb1)[02-9ac-hj-np-z]{11,71}$/i.test(a) || /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return "btc";
  if (isValidNearAccount(a.toLowerCase())) return "near";
  return undefined;
}

function hintFor(text: string, idx: number): string | undefined {
  const win = text.slice(Math.max(0, idx - 80), idx + 80);
  for (const [re, h] of ASSET_HINTS) if (re.test(win)) return h;
  return undefined;
}

function snippet(text: string, idx: number, len: number): string {
  const s = Math.max(0, idx - 40);
  const e = Math.min(text.length, idx + len + 40);
  return (s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : "");
}

/** Rule-based extraction over scammer turns (bait echoes are ignored to avoid self-poisoning). */
export function extractFromConversation(conv: Conversation, opts: { includeBait?: boolean } = {}): Extraction {
  const out: Extraction = { addresses: [], urls: [], phones: [], telegrams: [] };
  const seen = new Set<string>();
  conv.turns.forEach((t, i) => {
    if (t.role !== "scammer" && !opts.includeBait) return;
    const r = extractFromText(t.text);
    for (const a of r.addresses) {
      const key = `${a.chain}:${a.chain === "tron" || (a.chain === "btc" && !/^(bc1|tb1)/i.test(a.address)) ? a.address : a.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.addresses.push({ ...a, turnIndex: i });
    }
    for (const u of r.urls) if (!out.urls.includes(u)) out.urls.push(u);
    for (const p of r.phones) if (!out.phones.includes(p)) out.phones.push(p);
    for (const g of r.telegrams) if (!out.telegrams.includes(g)) out.telegrams.push(g);
  });
  return out;
}

export function extractFromText(rawText: string): Extraction {
  const text = normalizeChatText(rawText);
  const urls = [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  // blank out URLs so domain labels are not mistaken for NEAR accounts
  const scan = text.replace(URL_RE, (m) => " ".repeat(m.length));
  const addresses: Omit<ExtractedAddress, "turnIndex">[] = [];
  const push = (chain: Chain, m: RegExpMatchArray) =>
    addresses.push({ chain, address: m[0], assetHint: hintFor(scan, m.index!), context: snippet(text, m.index!, m[0].length) });
  for (const m of scan.matchAll(EVM_RE)) push("evm", m);
  for (const m of scan.matchAll(TRON_RE)) push("tron", m);
  for (const m of scan.matchAll(BTC_BECH32_RE)) push("btc", m);
  for (const m of scan.matchAll(BTC_LEGACY_RE)) push("btc", m);
  for (const m of scan.matchAll(NEAR_RE)) {
    if (isValidNearAccount(m[0].toLowerCase())) push("near", m);
  }
  const have = new Set(addresses.map((a) => a.address));
  for (const joined of joinSplitAddresses(scan)) {
    if (have.has(joined)) continue;
    const chain = detectChain(joined);
    if (!chain || chain === "near") continue;
    const idx = Math.max(0, scan.indexOf(joined.slice(0, 4)));
    have.add(joined);
    addresses.push({ chain, address: joined, assetHint: hintFor(scan, idx) ?? (chain === "tron" ? "USDT-TRC20" : undefined), context: snippet(text, idx, 60) + " (re-joined)" });
  }
  const phones = [...scan.matchAll(PHONE_RE)].map((m) => m[0].trim());
  const telegrams = [...scan.matchAll(TG_RE)].map((m) => m[0]);
  return { addresses: addresses.map((a) => ({ ...a, turnIndex: 0 })), urls, phones, telegrams };
}

/** Mask PII (phones, Telegram handles) in free text. */
export function redactText(text: string): string {
  return text.replace(PHONE_RE, "[phone redacted]").replace(TG_RE, "[telegram redacted]");
}

export function redactConversation(c: Conversation): Conversation {
  return { ...c, turns: c.turns.map((t) => ({ ...t, text: redactText(t.text) })) };
}
