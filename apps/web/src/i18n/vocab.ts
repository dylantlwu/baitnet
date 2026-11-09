import type { UiLang } from "./index";

/**
 * Free-text strings produced by the backend (upload warnings, TEE check names) come in the language of the
 * uploaded file / in English. Map the known shapes to the UI language; unknown strings pass through unchanged.
 */
type Rule = { re: RegExp; zh: (m: RegExpMatchArray) => string; en: (m: RegExpMatchArray) => string };

const WARNING_RULES: Rule[] = [
  { re: /^(?:No payment address found in the chat|缺少收款地址[:：].*)$/i, zh: () => "缺少收款地址：聊天记录里没有找到链上地址", en: () => "No payment address found in the chat" },
  { re: /^(?:Low scam-type confidence \(([\d.]+)\).*|类型置信度低（([\d.]+)）.*)$/i, zh: (m) => `类型置信度低（${m[1] ?? m[2]}），请人工确认骗局类型`, en: (m) => `Low scam-type confidence (${m[1] ?? m[2]}); please confirm the scam type` },
  { re: /^(?:Could not identify the scammer's messages|没有识别出骗子一方的发言)$/i, zh: () => "没有识别出骗子一方的发言", en: () => "Could not identify the scammer's messages" },
  { re: /^(?:No speakers detected.*|没有识别出说话人.*)$/i, zh: () => "没有识别出说话人，整段按骗子话术处理", en: () => "No speakers detected; treating every line as scammer text" },
  { re: /^(?:(\d+) injection line\(s\).*|发现 (\d+) 句注入\/诱导句.*)$/i, zh: (m) => `发现 ${m[1] ?? m[2]} 句注入/诱导句，已列入注入句`, en: (m) => `${m[1] ?? m[2]} injection line(s) found and listed under injections` },
  { re: /^(?:(\d+) address\(es\).*|(\d+) 个地址命中已知机构名单.*)$/i, zh: (m) => `${m[1] ?? m[2]} 个地址命中已知机构名单（疑似投毒），不会上链`, en: (m) => `${m[1] ?? m[2]} address(es) match known entities (likely poisoning) and will not go on-chain` },
  { re: /^(?:Redacted (\d+) (?:PII )?item.*?(?:evidence ([0-9a-f]{6,})).*|已打码 (\d+) 项个人资料.*?evidence ([0-9a-f]{6,}).*)$/i, zh: (m) => `已打码 ${m[1] ?? m[3]} 项个人资料；原文已加密保存（证据 ${m[2] ?? m[4]}…）`, en: (m) => `Redacted ${m[1] ?? m[3]} personal-data items; original stored encrypted (evidence ${m[2] ?? m[4]}…)` },
  { re: /^(?:Redacted (\d+).*|已打码 (\d+) 项个人资料.*)$/i, zh: (m) => `已打码 ${m[1] ?? m[2]} 项个人资料；原文已加密保存`, en: (m) => `Redacted ${m[1] ?? m[2]} personal-data items; original stored encrypted` },
  { re: /^(?:No actionable intel.*|没有可上链的情报.*)$/i, zh: () => "没有可上链的情报（地址/网址）", en: () => "No actionable intel (address / URL)" },
];

export function translateWarning(w: string, lang: UiLang): string {
  for (const r of WARNING_RULES) {
    const m = w.match(r.re);
    if (m) return lang === "zh" ? r.zh(m) : r.en(m);
  }
  return w;
}

const TEE_PARTS: [RegExp, string][] = [
  [/^model attestation present$/i, "模型证明报告存在"],
  [/^NVIDIA NRAS GPU attestation$/i, "NVIDIA NRAS GPU 证明"],
  [/^nonce echoed$/i, "回显了本次 nonce"],
  [/^TDX quote parses$/i, "TDX quote 可以解析"],
  [/^report_data binds signing_address \+ nonce$/i, "report_data 绑定了签名地址和 nonce"],
  [/^report_data field matches quote$/i, "report_data 字段与 quote 一致"],
  [/^measurements match tcb_info$/i, "度量值与 tcb_info 一致"],
  [/^event_log replays to RTMR3$/i, "event_log 重放结果等于 RTMR3"],
  [/^compose hash matches event_log$/i, "compose hash 与 event_log 一致"],
  [/^GPU evidence bound to nonce$/i, "GPU 证据绑定了 nonce"],
  [/^Intel DCAP quote signature$/i, "Intel DCAP quote 签名有效"],
  // older / sample names
  [/^Nonce freshly generated$/i, "nonce 为本次新生成"],
  [/^Intel TDX quote$/i, "Intel TDX quote"],
  [/^Report data binds signing address$/i, "report_data 绑定了签名地址"],
  [/^Report data binds nonce$/i, "report_data 绑定了 nonce"],
  [/^NVIDIA GPU attestation$/i, "NVIDIA GPU 证明"],
  [/^Event log replays to RTMR3$/i, "event_log 重放结果等于 RTMR3"],
];
const TEE_SCOPE: Record<string, string> = { model: "模型", gateway: "网关" };

export function translateTeeCheck(name: string, lang: UiLang): string {
  if (lang !== "zh") return name;
  const m = name.match(/^(\w+):\s*(.+)$/);
  const scope = m && TEE_SCOPE[m[1].toLowerCase()];
  const body = scope ? m![2] : name;
  const hit = TEE_PARTS.find(([re]) => re.test(body.trim()));
  if (!hit) return name;
  return scope ? `${scope}：${hit[1]}` : hit[1];
}
