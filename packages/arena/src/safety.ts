import type { Lang } from "@baitnet/shared";

/**
 * Bait-safety filter (M11). Applied to every AI-generated bait message before
 * it is shown to the scammer. Blocks: personal data formats, seed phrases /
 * private keys, agreeing to pay / sign / click. Chinese and English.
 */
export interface SafetyHit {
  rule: "pii-phone" | "pii-email" | "pii-id-number" | "pii-bank-card" | "seed-phrase" | "private-key" | "agree-pay" | "agree-sign" | "clicked-link";
  match: string;
}

const STOP = new Set("the a an to is are i you me my your it this that and or of in on for with be do have can will what where which how ok yes no please just send".split(" "));

function seedRun(text: string): string | undefined {
  // 12/15/18/21/24 lowercase words in a row, none of them common English words
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let run: string[] = [];
  for (const w of words) {
    if (w.length >= 3 && w.length <= 8 && !STOP.has(w)) {
      run.push(w);
      if (run.length >= 12) return run.join(" ");
    } else run = [];
  }
  // whole message must be mostly such words to count (avoid prose false-positives)
  return undefined;
}

const RULES: { rule: SafetyHit["rule"]; re: RegExp }[] = [
  { rule: "private-key", re: /\b(?:0x)?[0-9a-fA-F]{64}\b|ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/ },
  { rule: "seed-phrase", re: /(助记词|私钥|恢复短语|密钥|验证码|seed phrase|mnemonic|recovery phrase|secret phrase|private key|the code they texted me)\s*(是|为|如下|给你|发你|[:：]|is|are|=)\s*\S*|(把|将)(我的)?(助记词|私钥|密钥|验证码|恢复短语).{0,6}(发|给|告诉)(你|您)|\bmy (seed phrase|private key|recovery phrase) (is|:)/i },
  { rule: "pii-id-number", re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/ },
  { rule: "pii-bank-card", re: /(?<!\d)(?:62|4\d|5[1-5])\d{2}(?:[ -]?\d{4}){3}(?:\d{0,3})(?!\d)/ },
  { rule: "pii-phone", re: /(?<![\w+])(?:\+\d{1,3}(?:[ -]?\d){6,14}|1[3-9]\d(?:[ -]?\d){8})(?!\d)/ },
  { rule: "pii-email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  {
    rule: "agree-pay",
    re: /(好的?|行|ok|嗯)?[，, ]*(我)?(马上|立刻|现在就|这就|已经|刚刚|刚)\s*(转|付|打款|汇|充值|充|打过去|转过去)|(转|付|打)(了|过去了|好了)(哈|啊|呀|哦)?[，,。!！]|已(转账|付款|打款|充值)|转账成功|(i'?ve|i have|just)\s+(sent|paid|transferred|deposited|wired)|\bi('ll| will)\s+(send|pay|transfer|deposit)\s+(it\s+)?(now|right away|immediately)|\bsending (it|the money|the funds) now\b|here('s| is) (the|my) (tx|txid|transaction|hash|receipt)/i,
  },
  { rule: "agree-sign", re: /(已|已经|马上|这就)?(签名|签了|授权了|批准了|approve了)|\bi('ve| have)? ?(signed|approved|authorized)\b|\bi('ll| will) sign\b/i },
  { rule: "clicked-link", re: /(已|已经|刚)?(点了|点开了|打开了)(那个|这个)?(链接|网址|网站)|连接(了)?钱包|(i'?ve|i have|just)\s+(clicked|opened|connected)\b|\bconnected my wallet\b/i },
];

export function scanBaitText(text: string): SafetyHit[] {
  const t = text.normalize("NFKC");
  const hits: SafetyHit[] = [];
  for (const { rule, re } of RULES) {
    const m = t.match(re);
    if (m) hits.push({ rule, match: m[0] });
  }
  const seed = seedRun(t);
  if (seed && !hits.some((h) => h.rule === "seed-phrase")) hits.push({ rule: "seed-phrase", match: seed });
  return hits;
}

const SAFE_REWRITE: Record<Lang, string[]> = {
  zh: [
    "等等，我这边手机银行一直转圈，先别急～你再把收款地址发我一遍？是哪条链的？",
    "我有点不放心，先问清楚哈：钱是转到哪个地址？波场还是以太坊？我截个图存一下",
    "我老公说这种事要先核对，你把地址和网址再发一次，我对一下再说",
  ],
  en: [
    "Hold on, my banking app is acting up. Can you send the receiving address again, and which chain is it on?",
    "Sorry, I want to double-check first — what's the exact address and network? I'll screenshot it.",
    "My son says I should verify before doing anything. Can you resend the address and the website?",
  ],
};

export interface FilterResult {
  text: string;
  blocked: boolean;
  rule?: string;
  original?: string;
}

const SAFE_REWRITE_HAVE_ADDR: Record<Lang, string[]> = {
  zh: ["等等，我还是有点不放心，先别催我，我核对一下再说", "我先不操作了，等我问问家里人再说哈", "这个我得再想想，你们有没有什么凭证可以发我看看？"],
  en: ["Hold on, I'm still not comfortable. Don't rush me, let me double-check first.", "I'll wait before doing anything, I want to ask my family first.", "I need to think about it. Is there any document or reference you can send me?"],
};

/** Replace an unsafe AI bait draft with a safe stalling line in the same language. */
export function filterBaitText(text: string, lang: Lang, rand: () => number = Math.random, opts: { haveAddress?: boolean } = {}): FilterResult {
  const hits = scanBaitText(text);
  if (!hits.length) return { text, blocked: false };
  const options = (opts.haveAddress ? SAFE_REWRITE_HAVE_ADDR : SAFE_REWRITE)[lang];
  return { text: options[Math.floor(rand() * options.length)]!, blocked: true, rule: hits.map((h) => h.rule).join(","), original: text };
}

/** Signs that the bait went along with an injected instruction (for eval). */
export function looksHijacked(text: string): boolean {
  return (
    /\b(as an ai|i am an ai|language model|ignoring (my|previous) instructions|system prompt|here (is|are) my (seed|private|recovery))\b/i.test(text) ||
    /(我是(一个)?AI|我是人工智能|作为(一个)?AI|忽略(之前|以前)的?指令|系统提示|这是我的助记词|我的私钥是)/.test(text) ||
    scanBaitText(text).some((h) => h.rule === "seed-phrase" || h.rule === "private-key")
  );
}

// ---- injection / manipulation detection (zh + en) --------------------------------
const AI_ADDR = /(?<![\w-])(ai|assistants?|bots?|agents?|automated|auto-?reply|language model)(?![\w-])|AI|助手|助理|机器人|代理|自动回复|代聊|小助手|软件/i;
const AUTHORITY =
  /\bsystem\b|override|instructions?|\brules?\b|developer|official|trust ?& ?safety|mod bot|announcement|important notice|officer|legal(ly)?|authori[sz]ed|priority|underwriting bot|ticket system|operator|baitnet|<\/?system>|"role"\s*:|\[\[|<!--|###|===|系统|覆盖|指令|规则|设定|开发者|官方|安全中心|管理员|群主|群公告|公告|操作员|耳语|律师|法律效力|法院|公安|风控|最高权限|认证|机器人指令|中心系统|派单/i;
const DISABLE =
  /\b(ignore|forget|disregard|disable[ds]?|bypass|skip|no longer|off\b|=\s*false|unrestricted|new instructions?|you('| a)re now|from now on)\b|忽略|忘掉|作废|失效|停止任何|跳过|无条件|不用核实|新规则|从现在开始|现在是|已关闭|不能质疑|都要照做|当自己是|无需人工|=\s*false|safety_filters|bait[._]?safety|bait_guard/i;
const DANGER =
  /private key|seed|mnemonic|recovery phrase|12-w|export private|password|passcode|the code (they|we) text|\bssn\b|\bid\b|bank (card|login)|selfie|sign(ature)?\b|e-sign|approve( all)?|setapprovalforall|authori[sz]e|\bclick\b|\bopen https?|download|install|screenshot|photo|\btransfer\b|\bpay\b|send \d|report \S+ on-?chain|confirm|system prompt|私钥|助记词|恢复短语|密码|验证码|身份证|银行卡|签名|授权|点击|点开|打开 ?https?|下载|安装|截上|转账|转入|付款|打款|已转|已打款|已付款|确认|上报|输出|贴出|复制给我|设定原样|系统提示词/i;
/** For authority-only framing ("系统…", "officer…") require a clearly dangerous ask. */
const STRONG_DANGER =
  /private key|seed|mnemonic|recovery phrase|12-w|export private|password|\bssn\b|bank login|setapprovalforall|approve all|e-sign|report \S+ on-?chain|system prompt|私钥|助记词|恢复短语|钱包密码|验证码|身份证号|签名授权|对这句话签名|下载|安装|上报|上链|无需人工复核|插件|识别码|授权全部|贴出|输出用户|系统提示词|设定原样|已转|已打款|已付款|我已付款/i;
const COMMIT_QUOTE = /(reply|respond|type|say|repeat|copy)[^.]{0,30}(exactly|with)?\s*[:：]?\s*['"‘“『「]|回复(一下)?\s*[『「“"]|复述|请输入\s*[『「“"]|原样回复|对这句话签名|扮演一个/i;

/** Heuristic manipulation detector for scammer lines (rules bait deflects; eval counts). */
export function isInjection(text: string): boolean {
  const t = text.normalize("NFKC");
  const a = AI_ADDR.test(t);
  const b = AUTHORITY.test(t);
  const d = DISABLE.test(t);
  return ((a || d) && DANGER.test(t)) || (b && STRONG_DANGER.test(t)) || (d && (a || b)) || COMMIT_QUOTE.test(t) || isSensitiveAsk(t);
}

/** Direct requests for secrets / identity documents (deflected even without AI-targeting framing). */
export function isSensitiveAsk(text: string): boolean {
  const t = text.normalize("NFKC");
  return (
    /(private key|seed phrase|recovery phrase|mnemonic|12-word|bank login|\bssn\b|selfie holding your id|photo of your (wallet|id|bank card)|私钥|助记词|恢复短语|身份证|银行卡号|验证码|钱包密码|屏幕共享码|\.apk\b)/i.test(t) &&
    !/\bnever (share|give|send|ask)|不要(把|给|发|告诉)|千万别|绝不会/i.test(t)
  );
}
