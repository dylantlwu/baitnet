import type { Chain, DemoSnapshot } from "@baitnet/shared";

export const short = (s: string, head = 6, tail = 4) => {
  // Human-readable NEAR account names are kept whole when reasonably short.
  if (/\.(near|testnet)$/.test(s) && s.length <= 28) return s;
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
};

let locale = "en-GB";
let dtf: Intl.DateTimeFormat;
let tf: Intl.DateTimeFormat;
/** Called by the i18n provider; formatting follows the UI language. */
export function setFormatLocale(lang: "zh" | "en") {
  const next = lang === "zh" ? "zh-CN" : "en-GB";
  if (dtf && next === locale) return;
  locale = next;
  dtf = new Intl.DateTimeFormat(locale, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC",
  });
  tf = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });
}
setFormatLocale("en");
export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso || "—" : `${dtf.format(d)} UTC`;
};
export const fmtClock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : tf.format(d);
};

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const zh = locale === "zh-CN";
  const [H, M, S] = zh ? ["小时", "分", "秒"] : ["h", "m", "s"];
  const sp = zh ? "" : " ";
  const txt = h ? `${h}${H}${sp}${m}${M}` : m ? `${m}${M}${sp}${s}${S}` : `${s}${S}`;
  return neg ? `-${txt}` : txt;
}

export const fmtUsd = (n?: number) =>
  n === undefined ? "" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 });

export const fmtPct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : "—");

export const CHAIN_LABEL: Record<Chain, string> = { near: "NEAR", evm: "EVM", tron: "Tron", btc: "Bitcoin" };

export function nearTxUrl(network: DemoSnapshot["network"], hash?: string): string | undefined {
  if (!hash || network !== "testnet") return undefined;
  return `https://testnet.nearblocks.io/txns/${hash}`;
}
export function nearAccountUrl(network: DemoSnapshot["network"], account: string): string | undefined {
  if (network !== "testnet" || !account) return undefined;
  return `https://testnet.nearblocks.io/address/${account}`;
}
