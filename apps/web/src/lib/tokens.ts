import type { Chain } from "@baitnet/shared";

/**
 * Splits chat text into plain text, payment addresses, URLs and personal data.
 * Addresses / URLs are highlighted; personal data (phone, email, messenger handles) is redacted.
 */
export type Token =
  | { kind: "text"; value: string }
  | { kind: "address"; value: string; chain: Chain }
  | { kind: "url"; value: string; defanged: string }
  | { kind: "pii"; value: string; label: "phone" | "email" | "handle" };

const RULES: { re: RegExp; make: (m: string) => Token }[] = [
  { re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/y, make: (m) => ({ kind: "pii", value: m, label: "email" }) },
  { re: /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/y, make: (m) => ({ kind: "url", value: m, defanged: defang(m) }) },
  { re: /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/y, make: (m) => ({ kind: "address", value: m, chain: "evm" }) },
  { re: /T[1-9A-HJ-NP-Za-km-z]{33}(?![1-9A-Za-z])/y, make: (m) => ({ kind: "address", value: m, chain: "tron" }) },
  { re: /(?:bc1[a-z0-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})(?![0-9A-Za-z])/y, make: (m) => ({ kind: "address", value: m, chain: "btc" }) },
  { re: /[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:near|testnet)(?![\w.-]*\w)/y, make: (m) => ({ kind: "address", value: m, chain: "near" }) },
  { re: /@[A-Za-z0-9_]{4,32}/y, make: (m) => ({ kind: "pii", value: m, label: "handle" }) },
  { re: /\+\d[\d\s().-]{7,16}\d/y, make: (m) => ({ kind: "pii", value: m, label: "phone" }) },
];

export function defang(url: string): string {
  return url.replace(/^http/i, "hxxp").replace(/\./g, "[.]");
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    // Only start a match at a word boundary to avoid matching inside longer tokens.
    const prev = i > 0 ? text[i - 1] : " ";
    let matched = false;
    if (!/[A-Za-z0-9_@]/.test(prev)) {
      for (const r of RULES) {
        r.re.lastIndex = i;
        const m = r.re.exec(text);
        if (m) {
          if (buf) out.push({ kind: "text", value: buf });
          buf = "";
          out.push(r.make(m[0]));
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) buf += text[i++];
  }
  if (buf) out.push({ kind: "text", value: buf });
  return out;
}

export function extractAddresses(text: string): { value: string; chain: Chain }[] {
  return tokenize(text).flatMap((t) => (t.kind === "address" ? [{ value: t.value, chain: t.chain }] : []));
}
