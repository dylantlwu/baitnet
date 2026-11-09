import type { PiiFinding } from "@baitnet/shared";

/**
 * PII redaction for uploaded chat logs (M13 step 2), zh first-class + en.
 * Runs BEFORE any analysis or LLM call; only the redacted text ever leaves this module
 * in clear. Crypto addresses and URLs are intelligence, not PII, and are kept
 * (all numeric rules are bounded by [A-Za-z0-9] look-arounds so they never bite into
 * an address). Telegram / WeChat / QQ handles are PII (M2: handles only live in the
 * encrypted evidence).
 */

type Kind = PiiFinding["kind"];
const PREFIX: Record<Kind, string> = {
  name: "NAME",
  phone: "PHONE",
  email: "EMAIL",
  "id-number": "ID",
  "bank-card": "CARD",
  "address-postal": "ADDR",
  handle: "HANDLE",
};

const NB = "(?<![A-Za-z0-9])"; // no alnum before
const NA = "(?![A-Za-z0-9])"; // no alnum after

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// WeChat / QQ / Line / Telegram ids introduced by a label; group "v" is the value
const LABELED_HANDLE =
  /(?:微信号?|威信|薇信|v信|vx|wx|wechat|weixin|line\s?id|telegram|tg|飞机号?|纸飞机)\s*(?:号|ID|id)?\s*(?:是|为|:|：|=)?\s*(?<v>[A-Za-z][-_A-Za-z0-9]{5,31})(?![A-Za-z0-9_])/gi;
const QQ = /(?:QQ|qq|扣扣|企鹅号?)\s*(?:号|号码)?\s*(?:是|为|:|：)?\s*(?<v>[1-9]\d{4,11})(?!\d)/g;
const TG_AT = /(?<![\w.@])@[A-Za-z][A-Za-z0-9_]{4,31}\b/g;
const TME = /\b(?:https?:\/\/)?t\.me\/[A-Za-z0-9_+]{3,64}/gi;
// 18-digit PRC ID (last may be X), 15-digit legacy ID, US SSN, HKID
const CN_ID = new RegExp(`${NB}[1-9]\\d{5}(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]${NA}`, "g");
const CN_ID15 = new RegExp(`${NB}[1-9]\\d{7}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}${NA}`, "g");
const SSN = new RegExp(`${NB}(?!000|666|9\\d\\d)\\d{3}-\\d{2}-\\d{4}${NA}`, "g");
const HKID = /(?<![A-Za-z0-9])[A-Z]{1,2}\d{6}\s?\(?[0-9A]\)?(?![A-Za-z0-9])/g;
// bank cards: 16–19 digits, optionally grouped by 4 with spaces/dashes
const CARD = new RegExp(`${NB}(?:\\d{4}[ -]){3}\\d{4}(?:[ -]?\\d{1,3})?${NA}|${NB}\\d{16,19}${NA}`, "g");
// phones: CN mobile (+86 optional, spaces/dashes), intl +CC, US (xxx) xxx-xxxx, CN landline
const CN_MOBILE = new RegExp(`(?<![A-Za-z0-9+])(?:(?:\\+|00)?86[\\s-]?)?1[3-9]\\d(?:[\\s-]?\\d{4}){2}${NA}`, "g");
const INTL = /(?<![A-Za-z0-9])(?:\+|00)[1-9]\d{0,2}(?:[\s.-]?\(?\d{1,5}\)?){2,5}(?![A-Za-z0-9])/g;
const US = /(?<![A-Za-z0-9])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![A-Za-z0-9])/g;
const CN_LANDLINE = /(?<![A-Za-z0-9])0\d{2,3}-\d{7,8}(?![A-Za-z0-9])/g;
// postal addresses
const PROV = "北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门";
const ZH_ADDR = new RegExp(
  `(?:(?:${PROV})(?:省|市|自治区|特别行政区)?)?(?:[\\u4e00-\\u9fa5]{2,4}(?:市|州|盟))?(?:[\\u4e00-\\u9fa5]{1,4}(?:区|县|旗|镇))?[\\u4e00-\\u9fa5A-Za-z0-9]{1,8}?(?:路|街|大道|道|巷|弄|胡同|村)[\\u4e00-\\u9fa5A-Za-z0-9-]{0,8}?\\s*\\d{1,5}\\s*(?:号|弄)(?:\\s*[\\u4e00-\\u9fa5A-Za-z0-9-]{0,10}?\\s*\\d{0,5}\\s*(?:室|楼|栋|幢|座|单元|层|号楼))*`,
  "g",
);
const ZH_ADDR_LEAD = /^[我你他她们在住于到是寄送发往的家地址收货：:，, ]+/;
const EN_ADDR =
  /\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Parkway|Pkwy)\b\.?(?:,?\s*(?:Apt|Apartment|Suite|Unit|#)\.?\s*[\w-]+)?(?:,\s*[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)?(?:,\s*[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?/g;

// names
const ZH_SURNAMES =
  "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤";
const ZH_COMPOUND = "欧阳|司马|上官|诸葛|东方|慕容|司徒|皇甫|令狐";
const ZH_SUR = `(?:${ZH_COMPOUND}|[${ZH_SURNAMES}])`;
const ZH_NAME_INTRO = new RegExp(`(?:我叫|我的名字(?:是|叫)|名字(?:是|叫)|姓名\\s*[:：]?|本人|叫我|收件人\\s*[:：]?|户名\\s*[:：]?|持卡人\\s*[:：]?)\\s*(?<n>${ZH_SUR}[\\u4e00-\\u9fa5]{1,2})`, "g");
const ZH_NAME_IAM = new RegExp(`我是\\s*(?<n>${ZH_SUR}[\\u4e00-\\u9fa5]{1,2})(?=[，,。！!？?\\s~～]|$)`, "g");
// strong honorifics anywhere (王先生/李女士); weak ones (老师/总/哥/姐…) only at a word start or after 是/叫/找/跟…
const ZH_HONORIFIC = new RegExp(
  `${ZH_SUR}(?:先生|女士|小姐|太太)|(?:(?<![\\u4e00-\\u9fa5])|(?<=[是叫找和跟给问好]))${ZH_SUR}(?:老师|经理|总|阿姨|叔叔|大哥|大姐|哥|姐)`,
  "g",
);
const ZH_NOT_NAME = /^(?:王者|高手|高兴|金额|金融|马上|方便|方面|于是|万一|江湖|白天|钱包|钱的)/;

const EN_NOT_NAME = new Set(
  "Sorry Fine Good Here Not So Just Really Back Busy Ready Sure Glad Happy From In At With A An The Interested Still Going New Very Trying Calling Writing Sending Customer Sir Madam Friend Dear There All Everyone Team Support Admin Security Officer Agent Your Our This That Kraxon Binance Coinbase Telegram WhatsApp Bitcoin Ethereum Tether USDT USDC Okay Ok Yes No Thanks Thank Please Mr Mrs Ms Miss Dr".split(
    " ",
  ),
);
const EN_NAME = "[A-Z][a-z]{1,15}(?:[-'][A-Z]?[a-z]+)?";
const EN_NAME_INTRO = new RegExp(`\\b(?:[Mm]y name is|[Nn]ame\\s*:|I am|I'm|[Tt]his is|[Cc]all me|[Ii]t's)\\s+(?<n>${EN_NAME}(?:\\s+${EN_NAME})?)`, "g");
const EN_TITLE = new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Dr)\\.?\\s+(?<n>${EN_NAME}(?:\\s+${EN_NAME})?)`, "g");
const EN_GREET = new RegExp(`\\b(?:Dear|Hi|Hello|Hey|Thanks|Thank you),?\\s+(?<n>${EN_NAME})\\b`, "g");

/** Generic role labels that are not personal names. */
const ROLE_LABEL = /^(?:me|i|you|scammer|victim|bait|system|unknown|对方|我|你|骗子|受害者|客服|系统|群主|管理员|助理|老师)$/i;
export const isRoleLabel = (s: string) => ROLE_LABEL.test(s.trim());

export interface PiiSecret {
  kind: Kind;
  value: string;
  placeholder: string;
}

export class Redactor {
  private byValue = new Map<string, PiiSecret>();
  private counts = new Map<string, number>();
  private counters: Record<Kind, number> = { name: 0, phone: 0, email: 0, "id-number": 0, "bank-card": 0, "address-postal": 0, handle: 0 };
  private names = new Set<string>();

  private ph(kind: Kind, value: string): string {
    const key = `${kind}:${value.replace(/[\s-]/g, "").toLowerCase()}`;
    let s = this.byValue.get(key);
    if (!s) {
      s = { kind, value, placeholder: `[${PREFIX[kind]}_${++this.counters[kind]}]` };
      this.byValue.set(key, s);
    }
    this.counts.set(s.placeholder, (this.counts.get(s.placeholder) ?? 0) + 1);
    return s.placeholder;
  }

  /** Register a name (speaker label, detected intro) so every occurrence gets redacted. */
  addName(raw: string | undefined): void {
    const n = raw?.trim();
    if (!n || ROLE_LABEL.test(n) || n.length < 2 || /^\[[A-Z]+_\d+\]$/.test(n)) return;
    if (/^[一-龥]+$/.test(n) && ZH_NOT_NAME.test(n)) return;
    this.names.add(n);
    // English full names: also redact first / last name alone
    const parts = n.split(/\s+/).filter((p) => /^[A-Z][a-z]{2,}$/.test(p) && !EN_NOT_NAME.has(p));
    if (parts.length >= 2) for (const p of parts) this.names.add(p);
  }

  /** Pre-pass: collect names from intros / titles / greetings anywhere in the text. */
  collectNames(text: string): void {
    for (const re of [ZH_NAME_INTRO, ZH_NAME_IAM])
      for (const m of text.matchAll(re)) {
        let n = m.groups!.n!;
        n = n.replace(/(先生|女士|小姐|老师|哥|姐|啊|呀|的|了|吧)$/, "");
        if (n.length >= 2) this.addName(n);
      }
    for (const re of [EN_NAME_INTRO, EN_TITLE, EN_GREET])
      for (const m of text.matchAll(re)) {
        const parts = m.groups!.n!.split(/\s+/).filter((p) => !EN_NOT_NAME.has(p));
        if (parts.length) this.addName(parts.join(" "));
      }
  }

  redact(text: string): string {
    let t = text;
    const sub = (re: RegExp, kind: Kind, group?: string) => {
      t = t.replace(re, (...args) => {
        const whole = args[0] as string;
        const groups = args.at(-1) as Record<string, string> | undefined;
        if (group && groups?.[group]) {
          const v = groups[group]!;
          return whole.replace(v, this.ph(kind, v));
        }
        return this.ph(kind, whole);
      });
    };
    sub(EMAIL, "email");
    sub(TME, "handle");
    sub(LABELED_HANDLE, "handle", "v");
    sub(QQ, "handle", "v");
    sub(TG_AT, "handle");
    sub(CN_ID, "id-number");
    sub(CN_ID15, "id-number");
    sub(SSN, "id-number");
    sub(HKID, "id-number");
    sub(CARD, "bank-card");
    sub(CN_MOBILE, "phone");
    t = t.replace(INTL, (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15 ? this.ph("phone", m.trim()) : m;
    });
    sub(US, "phone");
    sub(CN_LANDLINE, "phone");
    t = t.replace(ZH_ADDR, (m) => {
      const lead = m.match(ZH_ADDR_LEAD)?.[0] ?? "";
      const core = m.slice(lead.length);
      return core.length >= 5 ? lead + this.ph("address-postal", core) : m;
    });
    sub(EN_ADDR, "address-postal");
    // names: honorific forms first (王先生), then every registered name, longest first
    t = t.replace(ZH_HONORIFIC, (m) => (ZH_NOT_NAME.test(m) ? m : this.ph("name", m)));
    for (const n of [...this.names].sort((a, b) => b.length - a.length)) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = /^[A-Za-z]/.test(n) ? new RegExp(`(?<![A-Za-z])${esc}(?![a-z])`, "g") : new RegExp(esc, "g");
      t = t.replace(re, () => this.ph("name", n));
    }
    return t;
  }

  findings(): PiiFinding[] {
    return [...this.byValue.values()].map((s) => ({ kind: s.kind, placeholder: s.placeholder, count: this.counts.get(s.placeholder) ?? 0 }));
  }

  /** Original values — only for the encrypted evidence blob. */
  secrets(): PiiSecret[] {
    return [...this.byValue.values()];
  }
}

/** One-shot helper: redact a single text (names detected within it). */
export function redactPII(text: string): { text: string; pii: PiiFinding[]; secrets: PiiSecret[] } {
  const r = new Redactor();
  r.collectNames(text);
  const out = r.redact(text);
  return { text: out, pii: r.findings(), secrets: r.secrets() };
}

/**
 * Redact the given string fields of a record with ONE Redactor, so the same person/phone
 * gets the same placeholder across fields (e.g. situation and badReply).
 */
export function redactFields<T extends object>(obj: T, fields: (keyof T)[]): T {
  const r = new Redactor();
  const vals = fields.map((f) => obj[f]).filter((v): v is T[keyof T] & string => typeof v === "string");
  r.collectNames(vals.join("\n"));
  const out = { ...obj };
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string") (out as Record<keyof T, unknown>)[f] = r.redact(v);
  }
  return out;
}
