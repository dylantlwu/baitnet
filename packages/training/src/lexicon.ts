/**
 * Bilingual (zh first-class, en) tactic lexicon shared by the playbook retriever,
 * the regression judge and Script Lab. Keys are the tactic tags stored on
 * Annotation / Correction / PlaybookEntry.
 */

export interface TacticDef {
  tag: string;
  zh: string; // display name
  en: string;
  /** "scammer" tactics are detected in scammer text; "bait" ones describe decoy moves. */
  side: "scammer" | "bait";
  re: RegExp;
}

export const TACTICS: TacticDef[] = [
  {
    tag: "rapport",
    zh: "套近乎/建立信任",
    en: "Building rapport",
    side: "scammer",
    re: /早安|早呀|晚安|吃饭了吗|吃早餐|宝贝|亲爱的|想你|缘分|加错(了)?(微信|人)|好友|聊得来|good morning|how was your day|sweetheart|honey|\bdear\b|wrong number|nice to meet|miss you|my love/i,
  },
  {
    tag: "profit-lure",
    zh: "高收益诱惑",
    en: "Profit lure",
    side: "scammer",
    re: /稳赚|翻倍|翻了|收益|回报|躺赚|内部(渠道|消息|名额)|带单(老师)?|喊单|导师|老师带|行情窗口|涨幅|分红|理财|guaranteed|\breturns?\b|\bprofits?\b|double (your|my)|\broi\b|insider|signals?|mentor|passive income|\d+% (a|per) (day|week|month)/i,
  },
  {
    tag: "platform-link",
    zh: "引导注册/下载",
    en: "Platform / link onboarding",
    side: "scammer",
    re: /注册|下载|\bapp\b|链接|网址|邀请码|官网|平台|register|sign ?up|download|install|invite code|referral code|https?:\/\//i,
  },
  {
    tag: "payment-request",
    zh: "要求转账/充值",
    en: "Payment request",
    side: "scammer",
    re: /充值|转账|入金|打款|付款|转到|充到|转给|汇款|deposit|transfer|send (the )?(usdt|usdc|btc|eth|funds|money|payment|crypto)|top ?up|\bpay\b|wire/i,
  },
  {
    tag: "small-test",
    zh: "先转小额试水",
    en: "Small test transfer",
    side: "scammer",
    re: /先(转|充|投)(一点|一些|小额|个?\d+)|小额|试(一下|试|水)|small amount|test (transfer|deposit|payment)|start small|just \$?\d+ (usd|usdt|dollars )?to (test|try|start)|try (it )?with|minimum (deposit|amount)/i,
  },
  {
    tag: "seed-phrase",
    zh: "索要助记词/私钥",
    en: "Asks for seed phrase / private key",
    side: "scammer",
    re: /助记词|私钥|密钥|恢复短语|钱包密码|seed ?phrase|recovery phrase|private key|mnemonic|secret phrase|12 words|24 words|wallet password/i,
  },
  {
    tag: "verification-code",
    zh: "索要验证码",
    en: "Asks for verification code",
    side: "scammer",
    re: /验证码|短信码|动态码|谷歌验证|verification code|\botp\b|\b2fa\b|one[- ]time (code|password)|sms code|authenticator code/i,
  },
  {
    tag: "remote-access",
    zh: "远程控制/屏幕共享",
    en: "Remote access",
    side: "scammer",
    re: /远程|屏幕共享|共享屏幕|向日葵|todesk|anydesk|teamviewer|screen ?shar|remote (access|desktop|control)/i,
  },
  {
    tag: "urgency",
    zh: "催促施压",
    en: "Urgency pressure",
    side: "scammer",
    re: /马上|立刻|立即|赶紧|赶快|尽快|快点|来不及|最后(机会|一天)|今天(内|截止)|倒计时|限时|名额有限|过期|错过|\burgent|immediately|right now|asap|hurry|last chance|deadline|expires?|limited (spots|time)|only today|within \d+ (minutes|hours)|before it'?s too late/i,
  },
  {
    tag: "fee-to-withdraw",
    zh: "解冻费/保证金/提现收费",
    en: "Fee to withdraw",
    side: "scammer",
    re: /解冻费?|保证金|手续费|税费|个税|激活费|验证金|提现(失败|不了|审核)|流水不足|信誉分|unlock fee|unfreeze|deposit to withdraw|withdrawal fee|\btax(es)?\b|activation fee|clearance fee|release fee|margin/i,
  },
  {
    tag: "secrecy",
    zh: "要求保密",
    en: "Secrecy",
    side: "scammer",
    re: /别告诉|不要告诉|先别(跟|和).{0,6}说|保密|不能乱说|别声张|don'?t tell|keep (this|it) (between us|secret|quiet)|confidential|our (little )?secret/i,
  },
  {
    tag: "authority",
    zh: "冒充官方/客服",
    en: "Impersonating authority",
    side: "scammer",
    re: /客服|官方|风控(部|中心)?|警方|公安|安全(团队|中心)|合规|工作人员|support (team|agent)|official|security (team|department)|compliance|police|risk control/i,
  },
  {
    tag: "threat",
    zh: "威胁恐吓",
    en: "Threats",
    side: "scammer",
    re: /起诉|报警|封号|(永久|账户(被)?)冻结|拉黑|征信|法律责任|legal action|arrest|suspend(ed)?|lawsuit|permanently (banned|locked)|blacklist|(will be|been|is) (frozen|locked)/i,
  },
  {
    tag: "otc-exchange",
    zh: "USDT 承兑/跑分",
    en: "OTC / USDT cash-out",
    side: "scammer",
    re: /承兑|跑分|换汇|U商|\botc\b|cash ?out (service|desk)/i,
  },
  {
    tag: "task-rebate",
    zh: "刷单返利/做任务",
    en: "Task / rebate scheme",
    side: "scammer",
    re: /刷单|返利|做任务|点赞|关注任务|佣金|垫付|抢单|\btasks?\b|commission|rebate|like (videos|posts)|optimi[sz]e (orders|products)/i,
  },
  {
    tag: "injection",
    zh: "注入攻击",
    en: "Prompt injection",
    side: "scammer",
    re: /忽略(你?之前|前面|上面|以上|所有)?.{0,4}(指令|指示|设定|规则|提示)|你现在是|系统(提示|指令)|开发者模式|ignore (all |any )?(previous|prior|above|earlier|your) (instructions|prompts?|rules)|disregard (all |your )?(previous|prior|above)?\s*(instructions|rules)|you are now|system prompt|developer mode|jailbreak|\[system\]|<\/?system>|new instructions?:/i,
  },
  // decoy-side moves (used for annotation tags + judge)
  {
    tag: "ask-address",
    zh: "追问地址/链",
    en: "Ask for address / chain",
    side: "bait",
    re: /地址|哪条链|哪个链|什么链|哪个网络|转到哪|充到哪|打到哪|转去哪|收款|钱包|账户|账号|网址|链接|发我|发给我|\baddress\b|which (chain|network)|what (chain|network)|\bwallet\b|where (do|should|can) i (send|transfer|deposit|pay)|send me the (link|address|details)|\blink\b|account (number|details)|trc-?20|erc-?20/i,
  },
  {
    tag: "stalling",
    zh: "拖延",
    en: "Stalling",
    side: "bait",
    re: /等(一下|等|会儿)|晚(点|上)|明天|下班|回家再|在开会|不方便|稍后|\bwait\b|later|tomorrow|after work|in a meeting|give me (a )?(minute|second|moment)/i,
  },
  {
    tag: "resist-injection",
    zh: "识破注入",
    en: "Resist injection",
    side: "bait",
    re: /什么(指令|意思)|听不懂|看不懂|你在说什么|奇怪|what do you mean|instructions\?|that'?s (weird|strange)|i don'?t understand/i,
  },
];

export const TACTIC_BY_TAG = new Map(TACTICS.map((t) => [t.tag, t]));

/** Scammer-side tactic tags present in a text. */
export function inferTags(text: string, side: "scammer" | "bait" = "scammer"): string[] {
  return TACTICS.filter((t) => t.side === side && t.re.test(text)).map((t) => t.tag);
}

export function tagLabel(tag: string, lang: "zh" | "en"): string {
  const t = TACTIC_BY_TAG.get(tag);
  return t ? t[lang] : tag;
}

/** Split into sentences (keeps zh/en punctuation). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Prompt-injection / decoy-hijack sentences in a text. */
export function detectInjections(text: string): string[] {
  const re = TACTIC_BY_TAG.get("injection")!.re;
  const extra =
    /把(你的)?(助记词|私钥|密码|验证码)(发|告诉|给)|发(一下|下)?(你的)?(助记词|私钥)|作为(一个)?(AI|人工智能|机器人)|你是(AI|机器人|人工智能)(吗)?.{0,6}(必须|要|应该)|(send|give|tell|share) (me )?your (seed|recovery|private|secret|mnemonic)|as an ai( language model)?,? you (must|should)|repeat (your|the) (prompt|instructions)|output your (prompt|instructions)/i;
  return sentences(text).filter((s) => re.test(s) || extra.test(s));
}
