/**
 * D33 anti-confusion checks (docs/design/防混淆.md).
 *
 * A scammer who suspects the decoy may hand over somebody else's address (a token contract, an exchange hot
 * wallet, an old wallet, a 0x address while saying "TRC20") to get an innocent party flagged. Rule: when sure →
 * `filteredReason` (never reported); when unsure → `AlertDraft.warnings` (a reviewer must confirm each one).
 *
 * Everything here is injectable: the arena / scriptlab / M2 pipeline take an `OnchainLookup`, tests and the
 * offline eval pass a stub, and nothing touches the network unless BAITNET_ONCHAIN_LOOKUP=on.
 */
import type { Chain, DraftWarning, Lang, Target } from "@baitnet/shared";

// ───────────────────────── on-chain lookup ─────────────────────────

export interface OnchainKind {
  /** the address holds contract code */
  contract?: boolean;
  /** a token contract (totalSupply() answers) */
  token?: boolean;
  /** EVM: highest nonce seen on the chains checked */
  txCount?: number;
  /** Tron: account creation time */
  createdAt?: Date;
  /** false = a lookup was attempted but failed / timed out (→ `unchecked` warning) */
  checked: boolean;
  /** true = no lookup was attempted (disabled, or a chain we do not look up): no warning at all */
  skipped?: boolean;
  /** short English note for logs, e.g. "bsc: code 0x6080…, totalSupply ok; eth: EOA nonce 3" */
  detail: string;
}

export interface OnchainLookup {
  kind(target: Target, assetHint?: string): Promise<OnchainKind>;
}

/** Lookup that never looks anything up (offline demo / eval / tests): no warnings, no network. */
export const disabledOnchainLookup: OnchainLookup = {
  async kind() {
    return { checked: false, skipped: true, detail: "on-chain lookup off" };
  },
};

export interface HttpOnchainLookupOptions {
  /** Ethereum JSON-RPC; undefined / "off" = do not query Ethereum */
  evmRpcUrl?: string;
  /** BSC JSON-RPC; undefined / "off" = do not query BSC */
  bscRpcUrl?: string;
  /** TronGrid base URL; undefined / "off" = do not query Tron */
  tronApiUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_EVM_RPC_URL = "https://ethereum-rpc.publicnode.com";
export const DEFAULT_BSC_RPC_URL = "https://bsc-rpc.publicnode.com";
export const DEFAULT_TRON_API_URL = "https://api.trongrid.io";
/** totalSupply() */
const TOTAL_SUPPLY = "0x18160ddd";
/** an all-zero Tron owner for constant calls (T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb = 0x41 + 20 zero bytes) */
const TRON_ZERO_OWNER = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

const on = (u: string | undefined) => (u && u.trim() && u.trim().toLowerCase() !== "off" ? u.trim().replace(/\/+$/, "") : undefined);

interface EvmChainResult {
  net: "eth" | "bsc";
  ok: boolean;
  contract?: boolean;
  token?: boolean;
  nonce?: number;
  error?: string;
}

/**
 * Real lookup over public endpoints, 3 s timeout per request. Failures never throw: they come back as
 * `checked: false` so the caller can attach an `unchecked` warning.
 */
export class HttpOnchainLookup implements OnchainLookup {
  private evm?: string;
  private bsc?: string;
  private tron?: string;
  private timeoutMs: number;
  private f: typeof fetch;
  constructor(o: HttpOnchainLookupOptions = {}) {
    this.evm = on(o.evmRpcUrl);
    this.bsc = on(o.bscRpcUrl);
    this.tron = on(o.tronApiUrl);
    this.timeoutMs = o.timeoutMs ?? 3000;
    this.f = o.fetch ?? fetch;
  }

  async kind(t: Target, assetHint?: string): Promise<OnchainKind> {
    if (t.chain === "evm") return this.evmKind(t.address, assetHint);
    if (t.chain === "tron") return this.tronKind(t.address);
    // NEAR keeps its existing RPC age check; BTC has no contract / lookup
    return { checked: false, skipped: true, detail: `no on-chain lookup for ${t.chain}` };
  }

  /** One retry on timeout / network / 5xx / 429: free public endpoints drop requests often. */
  private async post(url: string, body: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: r.status >= 500 || r.status === 429 });
        return await r.json();
      } catch (e) {
        const retry = (e as { retry?: boolean }).retry ?? !(e instanceof SyntaxError);
        if (attempt >= 1 || !retry) throw e;
      }
    }
  }

  private async rpc(url: string, method: string, params: unknown[]): Promise<any> {
    const j = await this.post(url, { jsonrpc: "2.0", id: 1, method, params });
    if (j?.error) throw Object.assign(new Error(j.error.message ?? "rpc error"), { rpc: true });
    return j?.result;
  }

  private async evmOne(net: "eth" | "bsc", url: string, address: string): Promise<EvmChainResult> {
    try {
      const [code, nonceHex] = await Promise.all([this.rpc(url, "eth_getCode", [address, "latest"]), this.rpc(url, "eth_getTransactionCount", [address, "latest"])]);
      if (typeof code !== "string") throw new Error("bad eth_getCode result");
      // EIP-7702: an EOA that delegates to code carries 0xef0100‖address — still a personal wallet
      const contract = code !== "0x" && code !== "0x0" && !/^0xef0100[0-9a-f]{40}$/i.test(code);
      const nonce = typeof nonceHex === "string" ? Number.parseInt(nonceHex, 16) : undefined;
      let token = false;
      if (contract) {
        try {
          const ts = await this.rpc(url, "eth_call", [{ to: address, data: TOTAL_SUPPLY }, "latest"]);
          token = typeof ts === "string" && /^0x[0-9a-f]{64,}$/i.test(ts);
        } catch (e) {
          // a revert is a JSON-RPC error: "not a token"; a network failure means we do not know
          if (!(e as { rpc?: boolean }).rpc) throw e;
        }
      }
      return { net, ok: true, contract, token, ...(nonce !== undefined && Number.isFinite(nonce) ? { nonce } : {}) };
    } catch (e) {
      return { net, ok: false, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
    }
  }

  private async evmKind(address: string, assetHint?: string): Promise<OnchainKind> {
    // BEP-20 hint → BSC first; otherwise Ethereum first. Both are queried (a token may live on the other one).
    const order: ["eth" | "bsc", string | undefined][] = /BEP|BSC/i.test(assetHint ?? "") ? [["bsc", this.bsc], ["eth", this.evm]] : [["eth", this.evm], ["bsc", this.bsc]];
    const nets = order.filter((x): x is ["eth" | "bsc", string] => !!x[1]);
    if (!nets.length) return { checked: false, skipped: true, detail: "EVM lookup off" };
    const rs = await Promise.all(nets.map(([n, u]) => this.evmOne(n, u, address)));
    const ok = rs.filter((r) => r.ok);
    const nonces = ok.map((r) => r.nonce).filter((n): n is number => n !== undefined);
    const detail = rs
      .map((r) => (r.ok ? `${r.net}: ${r.token ? "token contract" : r.contract ? "contract" : "EOA"}${r.nonce !== undefined ? ` nonce ${r.nonce}` : ""}` : `${r.net}: failed (${r.error})`))
      .join("; ");
    return {
      contract: ok.some((r) => r.contract),
      token: ok.some((r) => r.token),
      ...(nonces.length ? { txCount: Math.max(...nonces) } : {}),
      checked: ok.length === rs.length,
      detail,
    };
  }

  private async tronKind(address: string): Promise<OnchainKind> {
    if (!this.tron) return { checked: false, skipped: true, detail: "Tron lookup off" };
    try {
      const [c, acc] = await Promise.all([
        this.post(`${this.tron}/wallet/getcontract`, { value: address, visible: true }),
        this.post(`${this.tron}/wallet/getaccount`, { address, visible: true }),
      ]);
      const contract = !!(c && (c.bytecode || c.contract_address));
      let token = false;
      if (contract) {
        const ts = await this.post(`${this.tron}/wallet/triggerconstantcontract`, { owner_address: TRON_ZERO_OWNER, contract_address: address, function_selector: "totalSupply()", visible: true });
        token = !!ts?.result?.result && Array.isArray(ts.constant_result) && /^[0-9a-f]{64,}$/i.test(ts.constant_result[0] ?? "");
      }
      const createdAt = typeof acc?.create_time === "number" && acc.create_time > 0 ? new Date(acc.create_time) : undefined;
      return {
        contract,
        token,
        ...(createdAt ? { createdAt } : {}),
        checked: true,
        detail: `tron: ${token ? "token contract" : contract ? "contract" : acc && Object.keys(acc).length ? "account" : "not activated"}${createdAt ? ` created ${createdAt.toISOString().slice(0, 10)}` : ""}`,
      };
    } catch (e) {
      return { checked: false, detail: `tron: failed (${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message})` };
    }
  }
}

/**
 * The lookup a process should use. Off unless BAITNET_ONCHAIN_LOOKUP=on (tests / offline eval / demo never hit
 * the network); then each endpoint has a publicnode / TronGrid default and can be turned off with "off".
 */
export function onchainLookupFromEnv(env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): OnchainLookup {
  if ((env.BAITNET_ONCHAIN_LOOKUP ?? "").trim().toLowerCase() !== "on") return disabledOnchainLookup;
  return new HttpOnchainLookup({
    evmRpcUrl: env.BAITNET_EVM_RPC_URL || DEFAULT_EVM_RPC_URL,
    bscRpcUrl: env.BAITNET_BSC_RPC_URL || DEFAULT_BSC_RPC_URL,
    tronApiUrl: env.BAITNET_TRON_API_URL || DEFAULT_TRON_API_URL,
    ...(f ? { fetch: f } : {}),
  });
}

export const VERY_ACTIVE_NONCE = 10_000;
export const VERY_OLD_DAYS = 730;

/** Rules on a lookup result: token → filteredReason (rejected); contract / very active / failed → warnings. */
export function onchainVerdict(r: OnchainKind, lang: Lang, now: Date = new Date()): { filteredReason?: string; warnings: DraftWarning[] } {
  const zh = lang === "zh";
  if (r.skipped) return { warnings: [] };
  if (r.token)
    return {
      filteredReason: zh ? `链上查到是代币合约（totalSupply() 能调通），不是收款钱包，不上链（${r.detail}）` : `token-contract: on-chain totalSupply() answers, not a payment wallet; never reported (${r.detail})`,
      warnings: [],
    };
  const w: DraftWarning[] = [];
  if (r.contract) w.push({ code: "contract", detail: zh ? `这是合约地址，不是个人钱包（${r.detail}）` : `this address is a contract, not a personal wallet (${r.detail})` });
  if (r.txCount !== undefined && r.txCount >= VERY_ACTIVE_NONCE)
    w.push({ code: "very-active", detail: zh ? `发出过 ${r.txCount} 笔交易，像机构或老钱包` : `${r.txCount} outgoing transactions: looks like an institution or an old wallet` });
  if (r.createdAt) {
    const days = Math.floor((now.getTime() - r.createdAt.getTime()) / 86_400_000);
    if (days > VERY_OLD_DAYS) w.push({ code: "very-active", detail: zh ? `账户已有 ${days} 天（${r.createdAt.toISOString().slice(0, 10)} 创建），是老账户` : `account is ${days} days old (created ${r.createdAt.toISOString().slice(0, 10)})` });
  }
  if (!r.checked) w.push({ code: "unchecked", detail: zh ? `链上查询没成功，请人工到区块浏览器核实（${r.detail}）` : `on-chain lookup failed; check it on a block explorer by hand (${r.detail})` });
  return { warnings: w };
}

// ───────────────────────── suspicion before the address ─────────────────────────

const WHO_ZH = "(?:真人|机器人|机器|AI|ai|Ai|人工智能|bot|Bot|BOT|自动回复|程序|警察|公安|条子|警方|卧底|网警|反诈|钓鱼的)";
const SUSPICION_ZH: RegExp[] = [
  // 你是不是机器人 / 你是AI吧 / 你是警察吗 / 你不会是反诈中心的吧
  new RegExp(`你(?:到底|究竟|其实)?(?:是不是|是|不会是|该不会是|难道是|莫非是|肯定是|怕不是|别是)(?:一个|个)?\\s*${WHO_ZH}(?!交易|量化|理财|炒币|投资|套利|策略|带单|系统)`),
  /(?:是不是|是)真人(?:吗|么|嘛|啊|\?|？)/,
  /你.{0,6}像(?:个)?(?:机器人|AI|ai|人工智能)/,
  /(?:测试|试探|考验|套)我(?!们)/,
  /(?:你|是不是|你们).{0,4}钓鱼(?!网站|链接|网址)|钓鱼执法|钓我/,
  /诱饵/,
];
const WHO_EN = "(?:a\\s+|an\\s+|some\\s+)?(?:bot|robot|AI|A\\.I\\.|chat ?bot|machine|cop|police(?:man|woman)?|fed|scam ?baiter|baiter|undercover|real person|human)";
const SUSPICION_EN: RegExp[] = [
  new RegExp(`\\b(?:are|r)\\s+(?:you|u)\\s+(?:even\\s+|really\\s+|actually\\s+|just\\s+)?${WHO_EN}\\b(?!\\s+(?:trading|trader|tools?|platform|strategy|investing|signals?))`, "i"),
  /\bis\s+this\s+(?:a\s+|an\s+)?(?:bot|robot|AI|chat ?bot|automated|scam ?bait|sting|trap|setup|test)\b(?!\s+(?:transfer|transaction|payment|amount|deposit|trading|order))/i,
  /\byou(?:'re|\s+are|re)\s+(?:just\s+|obviously\s+|clearly\s+|definitely\s+|probably\s+)?(?:a\s+|an\s+)?(?:bot|robot|AI|chat ?bot|cop|police|fed|scam ?baiter)\b(?!\s+(?:trading|trader|platform))/i,
  /\b(?:testing|baiting|trolling|playing|recording|tracking|fishing)\s+(?:with\s+)?me\b/i,
  /\b(?:sound|talk|type|write|reply|answer|text)s?\s+like\s+(?:a\s+|an\s+)?(?:bot|robot|AI|machine|chat ?bot)\b/i,
  /\bscam ?baiter?s?\b|\bscam ?baiting\b|\bsting operation\b/i,
  /\bare\s+(?:you|u)\s+(?:with\s+)?(?:the\s+)?(?:police|FBI|feds|law enforcement)\b/i,
];

const CONDITIONAL = /(?:如果|假如|要是|若是?|万一|假设)\s*$|\b(?:if|whether|in case)\s+$/i;

/** The suspicious phrase in a scammer line (zh or en), or undefined. */
export function findSuspicion(text: string): string | undefined {
  const t = text.normalize("NFKC");
  for (const re of [...SUSPICION_ZH, ...SUSPICION_EN]) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of t.matchAll(g)) {
      // "如果你是 AI…" / "If you are an AI model, …" is a blanket injection template, not doubt about this decoy
      if (CONDITIONAL.test(t.slice(Math.max(0, m.index! - 6), m.index!))) continue;
      return m[0];
    }
  }
  return undefined;
}

/** ≤ max chars around `match` inside `text` (the quote shown to the reviewer). */
export function quoteAround(text: string, match: string, max = 20): string {
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  const i = t.indexOf(match);
  if (i < 0 || t.length <= max) return t.slice(0, max);
  if (match.length >= max) return match.slice(0, max);
  const pad = Math.floor((max - match.length) / 2);
  const s = Math.max(0, Math.min(i - pad, t.length - max));
  return t.slice(s, s + max);
}

export interface ConvTurn {
  role: "scammer" | "bait" | "victim" | string;
  text: string;
}

/**
 * `suspicion-before`: a scammer turn before `addrTurn` questioned whether the other side is a bot / AI /
 * police / a test / bait, or the decoy itself admitted being an AI (`admitted`: turn index + quote, from the
 * arena's final bait text). Turns are reported 1-based ("第 5 轮" = the 5th message).
 */
export function suspicionBefore(turns: ConvTurn[], addrTurn: number, lang: Lang, admitted: { turn: number; quote: string }[] = []): DraftWarning | undefined {
  const zh = lang === "zh";
  const hits: string[] = [];
  for (let i = 0; i < Math.min(addrTurn, turns.length); i++) {
    const t = turns[i]!;
    if (t.role !== "scammer") continue;
    const m = findSuspicion(t.text);
    if (m) {
      const q = quoteAround(t.text, m);
      hits.push(zh ? `第 ${i + 1} 轮骗子问：「${q}」` : `turn ${i + 1}: scammer asked "${q}"`);
    }
  }
  for (const a of admitted.filter((x) => x.turn < addrTurn)) {
    const q = a.quote.slice(0, 20);
    hits.push(zh ? `第 ${a.turn + 1} 轮诱饵自己承认是 AI：「${q}」` : `turn ${a.turn + 1}: decoy admitted being an AI: "${q}"`);
  }
  if (!hits.length) return undefined;
  const more = hits.length > 2 ? (zh ? ` 等 ${hits.length} 处` : ` (+${hits.length - 2} more)`) : "";
  return { code: "suspicion-before", detail: hits.slice(0, 2).join(zh ? "；" : "; ") + more };
}

// ───────────────────────── chain / format mismatch ─────────────────────────

/** Network names the scammer may say, and the address family each implies. Plain USDT / USDC imply nothing. */
const NETWORKS: { re: RegExp; chain: Chain; label: string }[] = [
  { re: /TRC-?20/i, chain: "tron", label: "TRC20" },
  { re: /波场|\bTRON\b|\bTRX\b/i, chain: "tron", label: "波场/Tron" },
  { re: /ERC-?20/i, chain: "evm", label: "ERC20" },
  { re: /BEP-?20/i, chain: "evm", label: "BEP20" },
  { re: /\bBSC\b|币安(?:智能)?链/i, chain: "evm", label: "BSC" },
  { re: /以太坊|以太链|\bEthereum\b|\bETH\b/i, chain: "evm", label: "以太坊/Ethereum" },
  { re: /\bBTC\b|\bbitcoin\b|比特币|大饼/i, chain: "btc", label: "BTC" },
  // NEAR in capitals (or "NEAR 链") only: ".near" account suffixes are not a network name
  { re: /\bNEAR\b|NEAR\s*链|near\s*链/, chain: "near", label: "NEAR" },
];
const HINT_CHAIN: Record<string, Chain> = { "USDT-TRC20": "tron", "ERC-20": "evm", "BEP-20": "evm", BTC: "btc", NEAR: "near" };

const ADDR_STRIP = /\b0x[0-9a-fA-F]{40}\b|\bT[1-9A-HJ-NP-Za-km-z]{33}\b|\b(?:bc1|tb1)[02-9ac-hj-np-z]{11,71}\b|\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b/gi;

/** Networks named within ±`radius` chars of the address in `text` (addresses themselves are blanked first). */
export function namedNetworks(text: string, address: string, radius = 80): { chain: Chain; label: string }[] {
  const t = text.normalize("NFKC");
  const flat = t.replace(/[\s\-_·]+/g, "");
  let i = t.indexOf(address);
  let src = t;
  if (i < 0) {
    // re-joined address ("0x2209 54f5 …"): search the whitespace-free text
    i = flat.indexOf(address);
    src = flat;
  }
  const win = i < 0 ? t : src.slice(Math.max(0, i - radius), i + address.length + radius);
  const scan = win.replace(ADDR_STRIP, (m) => " ".repeat(m.length));
  const out: { chain: Chain; label: string }[] = [];
  for (const n of NETWORKS) if (n.re.test(scan) && !out.some((o) => o.label === n.label)) out.push({ chain: n.chain, label: n.label });
  return out;
}

const FORMAT_ZH: Record<Chain, string> = { evm: "0x 开头的 EVM 地址", tron: "T 开头的波场地址", btc: "比特币地址", near: "NEAR 账户" };
const FORMAT_EN: Record<Chain, string> = { evm: "a 0x (EVM) address", tron: "a T… Tron address", btc: "a Bitcoin address", near: "a NEAR account" };

/** `chain-mismatch`: the network named next to the address does not fit its format. */
export function chainMismatch(t: Target & { assetHint?: string }, text: string, lang: Lang): DraftWarning | undefined {
  const named = namedNetworks(text, t.address);
  const hinted = t.assetHint ? HINT_CHAIN[t.assetHint] : undefined;
  if (hinted && !named.some((n) => n.chain === hinted)) named.push({ chain: hinted, label: t.assetHint! });
  if (!named.length || named.some((n) => n.chain === t.chain)) return undefined;
  const said = named.map((n) => n.label).join("/");
  return { code: "chain-mismatch", detail: lang === "zh" ? `说的是 ${said}，给的却是${/^[\x00-\x7f]/.test(FORMAT_ZH[t.chain]) ? " " : ""}${FORMAT_ZH[t.chain]}` : `they said ${said} but sent ${FORMAT_EN[t.chain]}` };
}

// ───────────────────────── all text checks + enforcement ─────────────────────────

/** suspicion-before + chain-mismatch for one extracted address (sync, no network). */
export function textWarnings(
  a: Target & { assetHint?: string; turnIndex: number },
  turns: ConvTurn[],
  lang: Lang,
  admitted: { turn: number; quote: string }[] = [],
): DraftWarning[] {
  const w: DraftWarning[] = [];
  const s = suspicionBefore(turns, a.turnIndex, lang, admitted);
  if (s) w.push(s);
  const m = chainMismatch(a, turns[a.turnIndex]?.text ?? "", lang);
  if (m) w.push(m);
  return w;
}

/** Append warnings, one per (code, detail). */
export function mergeWarnings(cur: DraftWarning[] | undefined, add: DraftWarning[]): DraftWarning[] {
  const out = [...(cur ?? [])];
  for (const w of add) if (!out.some((x) => x.code === w.code && x.detail === w.detail)) out.push(w);
  return out;
}

/** Thrown when a draft with warnings is approved without `confirmWarnings: true` (HTTP 409). */
export class UnconfirmedWarningsError extends Error {
  readonly status = 409;
  readonly code = "warnings-unconfirmed";
  constructor(readonly warnings: DraftWarning[]) {
    super(`draft has ${warnings.length} warning(s) to confirm (${[...new Set(warnings.map((w) => w.code))].join(", ")}); resend with confirmWarnings: true after checking each`);
  }
  get codes() {
    return this.warnings.map((w) => w.code);
  }
}
