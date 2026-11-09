import type { Lang } from "@baitnet/shared";

/** Backend-generated text in both languages; Chinese first (D16). */
export interface Bilingual {
  zh: string;
  en: string;
}
export const bi = (zh: string, en: string): Bilingual => ({ zh, en });
export const tr = (b: Bilingual, lang: Lang) => b[lang];

/** Accept-Language → zh | en. Chinese unless English is explicitly preferred over Chinese. */
export function langFromAcceptLanguage(header: string | undefined, fallback: Lang = "zh"): Lang {
  if (!header) return fallback;
  const prefs = header
    .split(",")
    .map((p) => {
      const [tag, ...params] = p.trim().toLowerCase().split(";");
      const q = Number(params.find((x) => x.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { tag: tag ?? "", q: Number.isFinite(q) ? q : 0 };
    })
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) {
    if (p.tag.startsWith("zh")) return "zh";
    if (p.tag.startsWith("en")) return "en";
  }
  return fallback;
}

const SAFETY_RULE_ZH: Record<string, string> = {
  "pii-phone": "手机号",
  "pii-email": "邮箱",
  "pii-id-number": "身份证号",
  "pii-bank-card": "银行卡号",
  "seed-phrase": "助记词",
  "private-key": "私钥",
  "agree-pay": "答应付款",
  "agree-sign": "答应签名",
  "clicked-link": "点链接/连钱包",
  "llm-quota-exceeded": "大模型额度用完",
};
export const safetyRuleZh = (rules: string) => rules.split(",").map((r) => SAFETY_RULE_ZH[r] ?? r).join("、");

const KIND_ZH: Record<string, string> = { "exchange-hot-wallet": "交易所热钱包", "token-contract": "代币合约", bridge: "跨链桥", protocol: "协议合约" };
/** M2 filter reasons for drafts, in the session language. */
export function knownEntityReason(name: string, kind: string, lang: Lang) {
  return lang === "zh" ? `已知机构地址：${name.replace(/\s*\([^)]*\)\s*$/, "")}（${KIND_ZH[kind] ?? kind}），不上链` : `known-entity: ${name} (${kind})`;
}
export function ageReason(detail: string, lang: Lang) {
  return lang === "zh" ? `账户年龄/活跃度可疑，暂缓上链：${detail.replace(/age (\d+)d \(sample data\)/, "账龄 $1 天（样例数据）").replace(/long-lived account, hold for review/, "老账户，需人工复核")}` : `age-activity: ${detail}`;
}
