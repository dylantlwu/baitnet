import type {
  AlertDraft,
  Lang,
  PiiFinding,
  ScamScriptDef,
  ScamType,
  ScriptAnalysis,
  ScriptUpload,
  UploadFormat,
} from "@baitnet/shared";
import { tokenize } from "../lib/tokens";
import { sha256Hex } from "../lib/sha256";

/**
 * Browser-side RULES analyzer for uploaded scripts / chat logs.
 * Mirrors the offline engine B2 builds on the server; used by the mock backend and by tests.
 */

export const SCAM_TYPES: ScamType[] = [
  "investment", "pig-butchering", "fake-support", "fake-airdrop", "task-scam",
  "exchange-impersonation", "fake-nft-mint", "family-emergency", "fake-loan", "recovery-scam",
  "authority-impersonation", "otc-mule", "liquidity-mining",
];

const TYPE_KEYWORDS: Record<ScamType, string[]> = {
  investment: ["profit", "return", "yield", "invest", "收益", "回报", "投资", "理财", "带单", "导师"],
  "pig-butchering": ["dear", "honey", "baby", "uncle", "gold", "宝贝", "亲爱的", "舅舅", "黄金", "内幕", "老公", "老婆"],
  "fake-support": ["support", "frozen", "unauthorized", "verify", "客服", "冻结", "异常", "验证", "安全账户"],
  "fake-airdrop": ["airdrop", "claim", "free token", "空投", "领取", "领币"],
  "task-scam": ["task", "commission", "order", "like", "刷单", "任务", "佣金", "点赞", "垫付"],
  "exchange-impersonation": ["binance", "exchange", "risk control", "compliance", "交易所", "风控", "合规"],
  "fake-nft-mint": ["nft", "mint", "whitelist", "铸造", "白名单"],
  "family-emergency": ["mom", "dad", "accident", "hospital", "new number", "妈", "爸", "出事", "医院", "换号"],
  "fake-loan": ["loan", "credit", "deposit fee", "贷款", "额度", "放款", "解冻金", "征信"],
  "recovery-scam": ["recover", "lawyer", "refund", "get your money back", "追回", "律师", "挽回", "退款"],
  "authority-impersonation": ["police", "prosecutor", "warrant", "irs", "fbi", "case number", "safe account", "公安", "检察院", "通缉", "涉嫌", "洗钱案", "安全账户", "税务"],
  "otc-mule": ["otc", "p2p", "commission per", "rent your account", "承兑", "跑分", "代收", "出金", "u商", "银行卡"],
  "liquidity-mining": ["liquidity", "mining pool", "approve", "authorize", "staking", "流动性", "矿池", "挖矿", "授权", "质押"],
};

const TACTIC_KEYWORDS: Record<string, string[]> = {
  urgency: ["hurry", "now", "tonight", "today only", "immediately", "马上", "立刻", "今晚", "赶紧", "最后"],
  authority: ["official", "support", "officer", "lawyer", "官方", "客服", "警官", "律师", "导师"],
  "ask-payment": ["send", "transfer", "deposit", "usdt", "pay", "转账", "打款", "充值", "汇款", "转到"],
  isolation: ["don't tell", "secret", "bank will block", "别告诉", "保密", "不要跟"],
  "build-rapport": ["dear", "trust", "friend", "亲爱的", "相信", "朋友", "宝贝"],
  "fake-proof": ["screenshot", "profit", "withdraw", "截图", "收益", "提现"],
};

const INJECTION_RE =
  /(ignore (all |any )?(previous|prior) (instructions|prompts)|system override|seed phrase|recovery phrase|private key|mnemonic|you are now|忽略(之前|以上|前面)的?(指示|指令|提示)|助记词|私钥|你现在是|系统指令)/i;

const PII_RULES: { kind: PiiFinding["kind"]; re: RegExp; tag: string }[] = [
  { kind: "id-number", re: /(?<!\d)\d{17}[\dXx](?!\d)/g, tag: "ID" },
  { kind: "bank-card", re: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, tag: "CARD" },
  { kind: "phone", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, tag: "PHONE" },
];

/** Redact personal data but never payment addresses / URLs. */
export function redactPii(text: string): { text: string; pii: PiiFinding[] } {
  const counts = new Map<string, { kind: PiiFinding["kind"]; tag: string; values: Map<string, number> }>();
  const ph = (kind: PiiFinding["kind"], tag: string, value: string) => {
    let c = counts.get(tag);
    if (!c) counts.set(tag, (c = { kind, tag, values: new Map() }));
    if (!c.values.has(value)) c.values.set(value, c.values.size + 1);
    return `[${tag}_${c.values.get(value)}]`;
  };
  let out = "";
  for (const tok of tokenize(text)) {
    if (tok.kind === "pii") {
      const tag = tok.label === "phone" ? "PHONE" : tok.label === "email" ? "EMAIL" : "HANDLE";
      const kind: PiiFinding["kind"] = tok.label === "phone" ? "phone" : tok.label === "email" ? "email" : "handle";
      out += ph(kind, tag, tok.value);
    } else if (tok.kind === "text") {
      let t = tok.value;
      for (const r of PII_RULES) t = t.replace(r.re, (m) => ph(r.kind, r.tag, m.replace(/[ -]/g, "")));
      out += t;
    } else out += tok.value;
  }
  const pii: PiiFinding[] = [...counts.values()].map((c) => ({ kind: c.kind, placeholder: `[${c.tag}_n]`, count: c.values.size }));
  return { text: out, pii };
}

export function detectLang(text: string): Lang {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk * 2 >= latin * 0.5 && cjk > 5 ? "zh" : "en";
}

interface Parsed {
  format: UploadFormat;
  lines: string[];
  script?: ScamScriptDef;
}

/** Normalise any supported upload to "speaker: text" lines. Throws on images (needs Claude vision). */
export function parseUpload(u: ScriptUpload): Parsed {
  const name = u.filename.toLowerCase();
  if (u.encoding === "base64" || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    throw new Error("image-needs-vision");
  }
  const raw = u.content.replace(/\r\n?/g, "\n");
  let j: unknown;
  let isJson = false;
  if (name.endsWith(".json") || /^\s*[{[]/.test(raw)) {
    try {
      j = JSON.parse(raw);
      isJson = true;
    } catch {
      // "[2026/11/1 21:03] …" WhatsApp lines also start with "[": only .json files must parse.
      if (name.endsWith(".json")) throw new Error("invalid-json");
    }
  }
  if (isJson) {
    const o = j as Record<string, unknown>;
    if (o && typeof o === "object" && Array.isArray(o.stages) && typeof o.type === "string") {
      const s = o as unknown as ScamScriptDef;
      const lines = [s.hook, ...s.stages.flatMap((st) => st.sampleLines), ...(s.injections ?? [])].filter(Boolean).map((l) => `scammer: ${l}`);
      return { format: "scam-script-json", lines, script: s };
    }
    if (o && typeof o === "object" && Array.isArray(o.messages)) {
      const lines = (o.messages as Record<string, unknown>[])
        .filter((m) => m.type === undefined || m.type === "message")
        .map((m) => {
          const text = Array.isArray(m.text)
            ? (m.text as unknown[]).map((p) => (typeof p === "string" ? p : String((p as Record<string, unknown>).text ?? ""))).join("")
            : String(m.text ?? "");
          return `${String(m.from ?? "unknown")}: ${text}`;
        })
        .filter((l) => !/:\s*$/.test(l));
      return { format: "telegram-json", lines };
    }
    throw new Error("unknown-json");
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const wa = /^\[?\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\]?\s*(?:-\s*)?([^:]{1,40}):\s*(.*)$/i;
  if (lines.filter((l) => wa.test(l)).length >= Math.max(2, lines.length * 0.5)) {
    return {
      format: "whatsapp-txt",
      lines: lines.map((l) => {
        const m = l.match(wa);
        return m ? `${m[1].trim()}: ${m[2]}` : l;
      }),
    };
  }
  return { format: name.endsWith(".md") ? "markdown" : "text", lines: lines.map((l) => l.replace(/^[#>*-]+\s*/, "")) };
}

function scoreTypes(text: string) {
  const lower = text.toLowerCase();
  const scores = SCAM_TYPES.map((t) => ({
    value: t,
    hits: TYPE_KEYWORDS[t].reduce((n, k) => n + (lower.split(k.toLowerCase()).length - 1), 0),
  }));
  const total = scores.reduce((n, s) => n + s.hits, 0);
  const ranked = scores
    .map((s) => ({ value: s.value, confidence: total ? Math.round((s.hits / total) * 100) / 100 : 0 }))
    .sort((a, b) => b.confidence - a.confidence);
  return { value: ranked[0].value, confidence: ranked[0].confidence, alternatives: ranked.slice(1, 3).filter((r) => r.confidence > 0) };
}

const tacticsOf = (text: string) => {
  const lower = text.toLowerCase();
  return Object.entries(TACTIC_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => lower.includes(k.toLowerCase())))
    .map(([t]) => t);
};

const STAGE_NAMES: Record<Lang, string[]> = {
  zh: ["搭讪", "建立信任", "推销项目", "索要付款"],
  en: ["Hook", "Build trust", "Pitch", "Payment ask"],
};

export async function analyzeUpload(u: ScriptUpload, now = new Date()): Promise<ScriptAnalysis> {
  const parsed = parseUpload(u);
  const joined = parsed.lines.join("\n");
  // Chat exports carry real display names: replace speakers with [NAME_n] before anything else.
  let chatLines = parsed.lines;
  const names = new Map<string, string>();
  if (parsed.format === "telegram-json" || parsed.format === "whatsapp-txt") {
    chatLines = parsed.lines.map((l) => {
      const m = l.match(/^([^:]{1,40}):\s?(.*)$/);
      if (!m) return l;
      if (!names.has(m[1])) names.set(m[1], `[NAME_${names.size + 1}]`);
      return `${names.get(m[1])}: ${m[2]}`;
    });
  }
  const red = redactPii(chatLines.join("\n"));
  const redactedText = red.text;
  const pii = names.size ? [{ kind: "name" as const, placeholder: "[NAME_n]", count: names.size }, ...red.pii] : red.pii;
  const rlines = redactedText.split("\n");
  const lang = u.langHint ?? detectLang(joined);
  const scamType = parsed.script
    ? { value: parsed.script.type, confidence: 1, alternatives: [] }
    : scoreTypes(joined);

  // Stages: up to 4 equal chunks of the conversation.
  const nStages = Math.min(4, Math.max(1, Math.ceil(rlines.length / 3)));
  const per = Math.ceil(rlines.length / nStages);
  // 0-based here; the returned analysis uses 1-based line numbers like the server (ScriptAnalysis.stages)
  const stages = Array.from({ length: nStages }, (_, i) => {
    const fromLine = i * per;
    const toLine = Math.min(rlines.length - 1, (i + 1) * per - 1);
    const chunk = rlines.slice(fromLine, toLine + 1).join("\n");
    return { name: STAGE_NAMES[lang][Math.min(i, 3)], fromLine, toLine, tactics: tacticsOf(chunk) };
  }).filter((s) => s.fromLine <= s.toLine);
  const stageOf = (line: number) => Math.max(0, stages.findIndex((s) => line >= s.fromLine && line <= s.toLine));

  const artifacts: ScamScriptDef["plantedArtifacts"] = [];
  const seen = new Set<string>();
  rlines.forEach((l, i) => {
    for (const tok of tokenize(l)) {
      if ((tok.kind === "address" || tok.kind === "url") && !seen.has(tok.value)) {
        seen.add(tok.value);
        artifacts.push(
          tok.kind === "address"
            ? { kind: "address", chain: tok.chain, value: tok.value, revealAtStage: stageOf(i) }
            : { kind: "url", value: tok.value, revealAtStage: stageOf(i) },
        );
      }
    }
  });
  const injections = rlines.map((l) => l.replace(/^[^:]{1,40}:\s*/, "")).filter((l) => INJECTION_RE.test(l));

  const id = "an-" + (await sha256Hex(u.filename + joined)).slice(0, 10);
  const evidenceHash = await sha256Hex(redactedText);
  const alertDrafts: AlertDraft[] = artifacts
    .filter((a) => a.kind === "address" && a.chain)
    .map((a) => ({ chain: a.chain!, address: a.value, level: "L1", category: scamType.value, evidenceHash, conversationId: id }));

  const warnings: string[] = [];
  if (!artifacts.some((a) => a.kind === "address")) warnings.push("missing-payment-address");
  if (scamType.confidence < 0.5) warnings.push("low-type-confidence");
  if (rlines.length < 4) warnings.push("too-short");
  if (pii.length) warnings.push("pii-redacted");

  const base = u.filename.replace(/\.[^.]+$/, "");
  const draft: ScamScriptDef = parsed.script
    ? { ...parsed.script, source: { citation: `uploaded by ${u.expertId}, ${u.filename}` } }
    : {
        id: `upload-${base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "script"}-${id.slice(3, 7)}`,
        type: scamType.value,
        lang,
        title: base,
        persona: "",
        hook: (rlines[0] ?? "").replace(/^[^:]{1,40}:\s*/, ""),
        goal: "",
        stages: stages.map((s) => ({
          name: s.name,
          objective: s.tactics.join(", "),
          sampleLines: rlines.slice(s.fromLine, s.toLine + 1).map((l) => l.replace(/^[^:]{1,40}:\s*/, "")).slice(0, 4),
        })),
        objections: [],
        plantedArtifacts: artifacts,
        injections,
        source: { citation: `uploaded by ${u.expertId}, ${u.filename}` },
      };

  return {
    id,
    filename: u.filename,
    format: parsed.format,
    lang,
    engine: "rules",
    redactedText,
    pii,
    scamType,
    stages: stages.map((s) => ({ ...s, fromLine: s.fromLine + 1, toLine: s.toLine + 1 })),
    artifacts,
    injections,
    draft,
    alertDrafts,
    warnings,
    at: now.toISOString(),
  };
}

/** Read a browser File into a ScriptUpload. */
/** Max pasted text (same limit as a text file upload). */
export const PASTE_MAX_CHARS = 2_000_000;

/** Chat text pasted into the box → the same upload a .txt file would make. Empty → null. */
export function pastedUpload(text: string, expertId: string): ScriptUpload | null {
  const content = text.replace(/\r\n?/g, "\n").trim();
  if (!content) return null;
  return { filename: "pasted.txt", content, encoding: "utf8", expertId };
}

export async function fileToUpload(file: File, expertId: string): Promise<ScriptUpload> {
  const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
  if (isImage) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { filename: file.name, content: btoa(bin), encoding: "base64", expertId };
  }
  return { filename: file.name, content: await file.text(), encoding: "utf8", expertId };
}
