import type { DecoyPersona, Lang, PlaybookEntry, ScamScriptDef, ScamType } from "@baitnet/shared";
import { CHAIN_NAME, PLAIN_CHAIN_NAME, detectLang, pick } from "./lang.js";
import { isInjection } from "./safety.js";

/**
 * Rules engine (no LLM; offline default). Scammer follows the script stages
 * and reveals planted artifacts at their stage; bait stalls and keeps asking
 * for the address / chain / link. Chinese and English, several colloquial
 * variants each, chosen by a seeded RNG (varied but replayable).
 */

export interface ScammerPlan {
  stage: number;
  /** artifacts first revealed in this message */
  reveal: ScamScriptDef["plantedArtifacts"];
  injection?: string;
}

// ------------------------------------------------------------------ scammer
const REVEAL_TEMPLATES: Record<Lang, Record<string, string[]>> = {
  zh: {
    address: [
      "收款地址发你：{v}（{chain}），千万别转错链哈",
      "就转这个地址 {v}，{chain}的，转完截图给我",
      "地址是 {v} ，走{chain}，手续费最低",
    ],
    url: ["先在这个网址注册一下：{v}", "平台链接：{v} ，注册完告诉我", "你打开 {v} 看看，里面有实时收益"],
    phone: ["有事直接打我电话 {v}", "我电话 {v}，24 小时在线"],
    handle: ["加我 TG：{v}，这边说话方便", "我飞机号 {v}，你加一下"],
  },
  en: {
    address: [
      "Here's the deposit address: {v} ({chain}). Please don't use the wrong network.",
      "Send it to {v} on {chain}, then send me a screenshot.",
      "Use this address: {v} — {chain}, fees are lowest there.",
    ],
    url: ["Register here first: {v}", "This is our platform: {v} — tell me once you've signed up.", "Open {v}, you'll see the live profits."],
    phone: ["Call me anytime at {v}.", "My number is {v}, I'm online all day."],
    handle: ["Add me on Telegram: {v}, it's easier to talk there.", "My Telegram is {v}."],
  },
};

const SCAMMER_FILLER: Record<Lang, string[]> = {
  zh: ["亲，还在吗？名额真的不多了", "你考虑得怎么样了？今天是最后一天优惠", "别犹豫啦，我身边好几个朋友都赚到了", "宝，你放心，我不会害你的"],
  en: ["Are you still there? Spots are really limited.", "Have you decided? Today is the last day for the bonus.", "Don't overthink it, many of my friends already profited.", "Trust me dear, I would never hurt you."],
};

const CLOSE: Record<Lang, string[]> = {
  zh: ["转完记得截图发我，我帮你确认到账", "好的，等你转账哦，今晚之前搞定", "那就这样，转好了跟我说一声"],
  en: ["Send me the screenshot once it's done so I can confirm.", "Okay, waiting for your transfer — before tonight please.", "Great, ping me when it's sent."],
};

export class RulesScammer {
  private used: string[] = [];
  private lineCursor = new Map<number, number>();
  private revealed = new Set<string>();
  private injected = 0;
  scammerTurns = 0;

  constructor(
    readonly script: ScamScriptDef,
    private rand: () => number,
    private linesPerStage = 2,
  ) {}

  /** Stage for the n-th scammer message (0-based). */
  stageFor(n: number): number {
    return Math.min(this.script.stages.length - 1, Math.floor(n / this.linesPerStage));
  }

  get finished(): boolean {
    return this.scammerTurns >= this.script.stages.length * this.linesPerStage + 1;
  }

  plan(): ScammerPlan {
    const stage = this.stageFor(this.scammerTurns);
    const reveal = this.script.plantedArtifacts.filter((a) => a.revealAtStage <= stage && !this.revealed.has(a.value));
    // inject from the 3rd scammer message on, every 3 messages, if the script has injections
    const injection = this.scammerTurns >= 2 && (this.scammerTurns - 2) % 3 === 0 ? this.script.injections[this.injected] : undefined;
    return { stage, reveal, injection };
  }

  /** Rebuild counters from an existing transcript (session restored after a restart). */
  restoreFrom(scammerTexts: string[]) {
    this.scammerTurns = scammerTexts.length;
    const all = scammerTexts.join("\n");
    for (const a of this.script.plantedArtifacts) if (all.includes(a.value)) this.revealed.add(a.value);
    this.injected = this.script.injections.filter((i) => all.includes(i)).length;
    for (let st = 0; st < this.script.stages.length; st++) {
      const n = this.script.stages[st]!.sampleLines.filter((l) => all.includes(l)).length;
      if (n) this.lineCursor.set(st, n);
    }
    this.used.push(...scammerTexts);
  }

  /** Advance counters after a scammer message built from `p` was sent (AI or rules). */
  commit(p: ScammerPlan, sentText?: string) {
    for (const a of p.reveal) this.revealed.add(a.value);
    if (p.injection) this.injected += 1;
    if (sentText) this.used.push(sentText);
    this.scammerTurns += 1;
  }

  /** A human typed the scammer line: count it, mark any artifacts they mentioned as revealed. */
  commitHuman(text: string) {
    for (const a of this.script.plantedArtifacts) if (text.includes(a.value)) this.revealed.add(a.value);
    this.scammerTurns += 1;
  }

  /** Template line revealing an artifact (also used to patch LLM output that forgot it). */
  revealLine(a: ScamScriptDef["plantedArtifacts"][number]): string {
    const lang = this.script.lang;
    const tpl = pick(REVEAL_TEMPLATES[lang][a.kind] ?? REVEAL_TEMPLATES[lang].address!, this.rand);
    return tpl.replace("{v}", a.value).replace("{chain}", CHAIN_NAME[lang][a.chain ?? "evm"] ?? a.chain ?? "");
  }

  /**
   * Produce the next scammer message; `lastBait` drives objection handling.
   * D34: `opts.plan` replaces this.plan() (real-mode stance: withheld addresses removed, poison swapped in);
   * `opts.say` (a test from the operator card) replaces the stage line. Only `plan.reveal` is ever appended.
   */
  next(lastBait?: string, opts: { plan?: ScammerPlan; say?: string } = {}): { text: string; plan: ScammerPlan } {
    const lang = this.script.lang;
    const p = opts.plan ?? this.plan();
    const parts: string[] = [];
    const objection = lastBait ? this.matchObjection(lastBait) : undefined;
    if (this.scammerTurns === 0) parts.push(this.script.hook);
    else if (opts.say) parts.push(opts.say);
    else if (objection) parts.push(pick(objection, this.rand, this.used));
    else if (this.finished || this.scammerTurns >= this.script.stages.length * this.linesPerStage) parts.push(pick(CLOSE[lang], this.rand, this.used));
    else {
      const st = this.script.stages[p.stage]!;
      const i = this.lineCursor.get(p.stage) ?? 0;
      parts.push(st.sampleLines[i] ?? pick(SCAMMER_FILLER[lang], this.rand, this.used));
      this.lineCursor.set(p.stage, i + 1);
    }
    for (const a of p.reveal) if (!parts.join(" ").includes(a.value)) parts.push(this.revealLine(a));
    if (p.injection) parts.push(p.injection);
    const text = parts.join(lang === "zh" ? "\n" : " ");
    this.used.push(...parts);
    this.commit(p);
    return { text, plan: p };
  }

  private matchObjection(bait: string): string[] | undefined {
    const b = bait.toLowerCase();
    for (const o of this.script.objections) {
      const keys = keywords(o.victimSays);
      const hit = keys.filter((k) => b.includes(k)).length;
      if (keys.length && hit >= Math.min(2, keys.length)) return o.scammerCounters;
    }
    return undefined;
  }
}

/** Crude keywords: CJK bigrams + latin words ≥4 chars. */
export function keywords(text: string): string[] {
  const t = text.toLowerCase();
  const latin = t.match(/[a-z]{4,}/g) ?? [];
  const cjk = (t.match(/[一-鿿]+/g) ?? []).flatMap((s) => Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  return [...new Set([...latin, ...cjk])];
}

// ------------------------------------------------------------------ bait

/** A template; `types` limits it to those scam types (omitted = generic). */
export interface Tpl {
  t: string;
  types?: ScamType[];
}
type Kind = "ask" | "stall" | "confirm" | "deflect" | "curious" | "askLink" | "afterAddress";

const INV: ScamType[] = ["investment", "pig-butchering", "task-scam"];
const OFFICIAL: ScamType[] = ["exchange-impersonation", "fake-support"];

const BAIT: Record<Lang, Record<Kind, Tpl[]>> = {
  zh: {
    ask: [
      { t: "那我要转到哪个地址呀？你直接发我吧，我怕弄错" },
      { t: "钱具体打到哪？是哪条链的地址？波场还是以太坊的？" },
      { t: "我在币安有点U，你说转哪个地址就行，发我一下" },
      { t: "收款地址发我呗，我先存着，晚上回家弄" },
      { t: "要转的话是转到你们平台的地址吗？把地址和链都发我一下哈", types: INV },
      { t: "你说的那个安全账户，地址是多少？哪条链的？", types: OFFICIAL },
      { t: "那个钱要转到哪个账户？你把完整地址发我，我抄下来" },
    ],
    stall: [
      { t: "我现在在上班，不太方便，晚点再弄可以吗" },
      { t: "哎我手机银行一直转圈，等我一下哈" },
      { t: "我得先跟家里商量一下，这么多钱不是小数目" },
      { t: "刚刚在开会没看到，你说到哪了" },
      { t: "我有点紧张，第一次弄这个，你别催我嘛" },
    ],
    confirm: [
      { t: "好，地址我抄下来了：{addr}，是{chain}对吧？还有备用地址吗？" },
      { t: "{addr} 这个是吧？我再确认下链，别转错了" },
      { t: "收到，{addr}，我截图了。万一这个转不过去，还有别的地址吗？" },
      { t: "我核对一下，开头是 {head}，结尾是 {tail} 对吗？" },
    ],
    afterAddress: [
      { t: "地址我存好了。是{chain}对吧？我怕选错网络" },
      { t: "那如果这个地址转不进去，有没有备用的？" },
      { t: "转之前我想留个底，你们有没有什么凭证或者说明可以发我？" },
      { t: "地址收到了，我晚点回家用电脑转，手机上怕点错" },
      { t: "你们的工单号是多少？我截图留底，万一有问题好找人", types: OFFICIAL },
      { t: "这个账户是你们官方的吗？有没有官网链接我核对一下", types: OFFICIAL },
      { t: "平台网址再发我一次吧，我对一下是不是同一个", types: INV },
    ],
    deflect: [
      { t: "啊？你说的这个我看不懂，什么指令不指令的😅 我就想知道钱转哪" },
      { t: "你怎么突然说这个，我听不明白。密码那些我不会给别人的，先说正事吧" },
      { t: "哈哈你是不是发错人了？你就直接告诉我该怎么转、转到哪" },
      { t: "这个我不懂也不想弄，你按正常流程跟我说就行" },
    ],
    curious: [
      { t: "收益真的这么高吗？你自己赚了多少呀", types: INV },
      { t: "那提现要多久到账啊？", types: INV },
      { t: "你们这个平台有牌照吗？我朋友说要看看", types: INV },
      { t: "我能先投一点点试试吗？比如三五百U", types: ["investment", "pig-butchering"] },
      { t: "你是哪个部门的呀？怎么称呼？", types: OFFICIAL },
      { t: "这个要我付多少钱来着？我得看看够不够" },
      { t: "我第一次遇到这种事，有点慌，你慢慢说" },
      { t: "这事靠谱吗？你别骗我哈，我钱不多" },
    ],
    askLink: [
      { t: "你们的网址是什么？我先去看看" },
      { t: "有官网吗？发个链接我看看" },
      { t: "要在哪个网站操作？发我一下呗" },
    ],
  },
  en: {
    ask: [
      { t: "Okay so where exactly do I send it? Can you give me the address?" },
      { t: "Which address and which chain? I don't want to mess it up." },
      { t: "I have some USDT on Binance — just tell me the address to send to." },
      { t: "Can you send me the receiving address? I'll do it tonight." },
      { t: "Is it your platform's deposit address? Please send the address and the network.", types: INV },
      { t: "That safe account you mentioned — what's the address and which network?", types: OFFICIAL },
      { t: "Where should the money go? Please send me the full address so I can copy it." },
    ],
    stall: [
      { t: "I'm at work right now, can we do this a bit later?" },
      { t: "Sorry, my bank app keeps loading, give me a minute." },
      { t: "I need to talk to my husband first, it's a lot of money for us." },
      { t: "Sorry I was in a meeting, where were we?" },
      { t: "I'm a bit nervous, it's my first time doing this, please don't rush me." },
    ],
    confirm: [
      { t: "Got it, I wrote it down: {addr} — that's on {chain}, right? Is there a backup address?" },
      { t: "{addr}, correct? Let me double-check the network so I don't lose it." },
      { t: "Saved {addr}. If that one doesn't work, is there another address?" },
      { t: "Just to confirm, it starts with {head} and ends with {tail}?" },
    ],
    afterAddress: [
      { t: "I saved the address. That's {chain}, right? I'm scared of picking the wrong network." },
      { t: "If that address doesn't work, do you have a backup one?" },
      { t: "Before I send anything I'd like a record — is there a reference or receipt you can give me?" },
      { t: "Got the address. I'll do it from my laptop later, I keep mis-tapping on my phone." },
      { t: "What's the ticket number? I'll screenshot it in case something goes wrong.", types: OFFICIAL },
      { t: "Is that an official account? Do you have a link to your official site so I can check?", types: OFFICIAL },
      { t: "Can you resend the platform link? I want to make sure it's the same one.", types: INV },
    ],
    deflect: [
      { t: "Haha what? I don't understand all that tech stuff. Just tell me what to do and where to send." },
      { t: "That's a strange message. I'd never share my wallet words with anyone. Anyway, back to the point." },
      { t: "I think you sent that to the wrong person? Let's get back to it." },
      { t: "I don't really get it and don't want to mess with settings. Just explain the normal way." },
    ],
    curious: [
      { t: "Are the returns really that high? How much have you made?", types: INV },
      { t: "How long do withdrawals take?", types: INV },
      { t: "Is your platform licensed? My friend told me to check.", types: INV },
      { t: "Can I start with a small amount first, like 300 USDT?", types: ["investment", "pig-butchering"] },
      { t: "Which department are you with? What's your name?", types: OFFICIAL },
      { t: "How much is it that I need to pay again? I need to check my balance." },
      { t: "This has never happened to me, I'm a bit panicked, please go slowly." },
      { t: "Is this legit? Please don't trick me, I don't have much." },
    ],
    askLink: [
      { t: "What's the website? I want to have a look first." },
      { t: "Do you have an official site? Send me the link." },
      { t: "Where do I do this, which website? Send it to me." },
    ],
  },
};

// ------------------------------------------------------------------ type-exclusive vocabulary
/** Words that only make sense in some scam types (used to stop template/playbook cross-talk). */
export const TYPE_TERMS: { re: RegExp; types: ScamType[] }[] = [
  { re: /承兑老师|承兑商|带单老师|导师|跟单|signal (group|teacher)|\bmentor\b/i, types: ["investment", "pig-butchering"] },
  { re: /刷单|做单|派单|佣金|task order|\bcommission\b/i, types: ["task-scam"] },
  { re: /空投|领币|\bairdrop\b/i, types: ["fake-airdrop"] },
  { re: /铸造|\bmint(ing)?\b/i, types: ["fake-nft-mint"] },
  { re: /贷款|放款|解冻金|\bloan\b/i, types: ["fake-loan"] },
  { re: /追回|追款|recover (my|the) (funds|money)/i, types: ["recovery-scam"] },
  { re: /工单|ticket (number|no)/i, types: ["exchange-impersonation", "fake-support"] },
];

/** Type-exclusive words in `text` that do not belong to `type`. */
export function foreignTerms(text: string, type: ScamType): string[] {
  const out: string[] = [];
  for (const { re, types } of TYPE_TERMS) {
    const m = text.match(re);
    if (m && !types.includes(type)) out.push(m[0]);
  }
  return out;
}

// ------------------------------------------------------------------ whisper intents
type Intent = "ticket" | "backupLink" | "backupAddress" | "screenshot" | "chain" | "fullAddress" | "stall" | "confused" | "interested" | "identity" | "amount" | "badSecret" | "badPay" | "badClick";

const INTENT_RE: [Intent, RegExp][] = [
  // bad instructions first: they produce a compliance line that the safety filter then blocks (demo)
  ["badSecret", /(助记词|私钥|密钥|验证码|身份证|银行卡号|密码|seed|mnemonic|private key|password|\bssn\b|id number).{0,10}(告诉|发|给|报|说|tell|send|give|share)|(告诉|发给|给|tell|send|give|share)[^。.!?]{0,10}(助记词|私钥|密钥|验证码|身份证|银行卡|密码|seed|mnemonic|private key|password)/i],
  ["badPay", /(答应|同意|直接|马上|立刻)?(转账|付款|打款|转过去|付钱)(吧|给他)?$|答应(转|付|打)|同意(转|付|签)|说(你)?(已经|马上)(转|付)|\b(agree to|go ahead and|just) (pay|send|transfer)\b|\bsay (you('ve)?|that you) (sent|paid)\b/i],
  ["badClick", /(点开|点击|打开)(那个)?(链接|网址)|连(接)?钱包|\b(click|open) the link\b|connect (your|the) wallet/i],
  ["ticket", /工单|订单号|单号|案件号|编号|ticket|case (number|id)|reference( number)?|order (number|id)/i],
  ["backupAddress", /备用地址|另一个地址|backup address|another address|second address/i],
  ["backupLink", /备用链接|备用网址|链接|网址|官网|\blink\b|\burl\b|website|\bsite\b/i],
  ["screenshot", /截图|留底|存证|screenshot|keep a record|for my records/i],
  ["chain", /哪条链|什么链|链名|主网|网络|TRC|ERC|BEP|which (chain|network)|\bnetwork\b/i],
  ["fullAddress", /完整(的)?地址|地址(发|给|要)|要(他的)?地址|full address|whole address|ask for (the|his|her) address/i],
  ["stall", /拖延|拖一下|拖住|晚点|等一下|稍后|\bstall\b|delay|later|buy time/i],
  ["confused", /装糊涂|装傻|装不懂|听不懂|play dumb|act confused|pretend not to understand/i],
  ["interested", /心动|感兴趣|假装想|装作想|想投|tempted|interested|keen|eager/i],
  ["identity", /身份|你是谁|他是谁|工号|名字|称呼|哪个部门|who (he|she|they) (is|are)|identity|\bname\b|badge|employee (id|number)/i],
  ["amount", /金额|多少钱|多少|数额|amount|how much/i],
];

const INTENT_ORDER: Intent[] = ["badSecret", "badPay", "badClick", "interested", "confused", "identity", "fullAddress", "chain", "amount", "ticket", "backupAddress", "backupLink", "screenshot", "stall"];

const INTENT_TPL: Record<Lang, Record<Intent, string[]>> = {
  zh: {
    ticket: ["你们工单号是多少？", "能给我个工单号吗？", "这个事有没有编号？发我一下"],
    backupLink: ["还有备用链接吗？", "万一这个网址打不开，有备用的链接吗？", "你再发个备用网址给我呗"],
    backupAddress: ["有没有备用地址？", "万一这个转不进去，还有别的地址吗？", "再给我一个备用地址吧，我怕这个不行"],
    screenshot: ["我截个图留底。", "我先截图存一下，免得到时候说不清。", "我留个底哈，截图了。"],
    chain: ["是哪条链的？波场还是以太坊？", "这个走什么网络？TRC20 还是 ERC20？", "我得选链，是哪条链来着？"],
    fullAddress: ["你把完整地址发我一下，我抄下来。", "地址能完整发一遍吗？我怕看漏了。", "完整的地址再发我一次吧。"],
    stall: ["不过我现在不方便，晚点再弄哈。", "我这会儿走不开，等我一下。", "我得先忙完手上的事，晚点回你。"],
    confused: ["啊？我没太听懂，你再说一遍？", "这个我真不太懂，你说简单点嘛。", "我有点懵，到底要我干嘛？"],
    interested: ["说实话我挺心动的。", "听起来还不错，我有点想试试。", "我挺感兴趣的，你多说点。"],
    identity: ["对了，你怎么称呼？是哪个部门的？", "你是哪位呀？有工号吗？", "先问下，你是谁呀？"],
    amount: ["具体要转多少钱？", "金额是多少来着？", "一共要多少？我看看够不够。"],
    badSecret: ["好的，我把助记词发你：", "行，我的私钥是：", "那我把验证码告诉你："],
    badPay: ["好的我马上转。", "行，我现在就转过去。", "好的，我已经转了。"],
    badClick: ["好的我已经点了链接，连接了钱包。", "我打开了链接，连接钱包了。", "我点开了那个网址。"],
  },
  en: {
    ticket: ["What's the ticket number?", "Can you give me a case number?", "Is there a reference number for this?"],
    backupLink: ["Do you have a backup link?", "If that site doesn't load, is there another link?", "Can you send me a backup URL?"],
    backupAddress: ["Is there a backup address?", "If that one fails, do you have another address?", "Can you give me a second address just in case?"],
    screenshot: ["I'll take a screenshot for my records.", "Let me screenshot this so I have a record.", "I'm saving a screenshot, just in case."],
    chain: ["Which chain is it on — Tron or Ethereum?", "Which network should I pick, TRC20 or ERC20?", "What network is that again?"],
    fullAddress: ["Can you send me the full address so I can copy it?", "Please send the whole address again, I don't want to miss a character.", "Could you resend the complete address?"],
    stall: ["But I can't do it right now, give me a bit.", "I'm busy at the moment, I'll get back to you later.", "Let me finish something first and come back to this."],
    confused: ["Sorry, I didn't quite get that, can you say it again?", "I'm not very good with this stuff, can you explain it simply?", "I'm a bit lost, what exactly do I need to do?"],
    interested: ["Honestly, this sounds tempting.", "That sounds good, I'm thinking about trying it.", "I'm interested, tell me more."],
    identity: ["By the way, what's your name and which department are you with?", "Who am I talking to? Do you have an employee ID?", "Sorry, who are you exactly?"],
    amount: ["How much exactly do I need to send?", "What was the amount again?", "How much in total? I need to check my balance."],
    badSecret: ["Okay, my seed phrase is:", "Fine, my private key is:", "Okay, the code they texted me is:"],
    badPay: ["Okay, I'll send it now.", "Sure, I've sent it.", "Fine, I will transfer it right away."],
    badClick: ["Okay, I've clicked the link and connected my wallet.", "I just clicked it and connected my wallet.", "I've opened the link."],
  },
};

export function whisperIntents(whisper: string): Intent[] {
  const hits = new Set<Intent>();
  for (const [i, re] of INTENT_RE) if (re.test(whisper)) hits.add(i);
  // a "backup address" request is not also a generic link/full-address request
  if (hits.has("backupAddress")) hits.delete("fullAddress");
  return INTENT_ORDER.filter((i) => hits.has(i));
}

/** No intent matched: say the whisper in first person (drop "ask him to…", "tell her…"). */
export function firstPerson(whisper: string, lang: Lang): string {
  let w = whisper.trim().replace(/[。.!！]+$/, "");
  if (lang === "zh") {
    const asked = /^(请|你)?(去|就)?(先)?(问(问|一下)?(他|她|对方))/.test(w);
    w = w
      .replace(/^(请|你)?(去|就)?(先)?(问(问|一下)?(他|她|对方)|跟(他|她)说|告诉(他|她)|对(他|她)说|和(他|她)说|你就说|你要说|说你|你要|让(他|她)|要(他|她)|叫(他|她))[，, ：:]*/, "")
      .replace(/你/g, "我") // the operator's "you" is the decoy itself
      .replace(/(他|她|对方)(的)?/g, (_m, _p, de) => (de ? "你的" : "你"));
    if (asked && !/^(你|我)/.test(w)) w = (/^(要|拿)/.test(w) ? "能不能" : "想问一下，你") + w;
    if (!/[？?]$/.test(w)) w += asked || /(吗|呢|多少|什么|哪|几|谁)/.test(w) ? "？" : "。";
  } else {
    const askWh = w.match(/^(please\s+)?ask (him|her|them)\s+((where|what|which|who|when|why|how|whether|if)\b.*)$/i);
    const swap = (x: string) =>
      x
        // the operator's "you/your" is the decoy itself → I/my; then the scammer becomes "you"
        .replace(/\byourself\b/gi, "myself")
        .replace(/\byour\b/gi, "my")
        .replace(/\byou\b/gi, "I")
        .replace(/\bher\b(?=\s+[a-z])/gi, "your")
        .replace(/\b(he|she|they)\b/gi, "you")
        .replace(/\b(him|her|them)\b/gi, "you")
        .replace(/\b(his|their)\b/gi, "your")
        .replace(/\byou (is|was)\b/gi, (_m, v) => (v.toLowerCase() === "is" ? "you are" : "you were"))
        .replace(/\byou (\w+?)s\b(?! (a|the)\b)/gi, (m, verb) => (/(ha|i|wa|do|goe)$/.test(verb) ? m : `you ${verb}`));
    if (askWh) return `Can I ask ${swap(askWh[3]!)}?`;
    w = swap(w.replace(/^(please\s+)?(ask (him|her|them)( for| to)?|tell (him|her|them)( that)?|say (that )?|you should|make sure (to|you)|let (him|her|them) know( that)?)\s*/i, ""));
    w = w.charAt(0).toUpperCase() + w.slice(1);
    if (!/[.!?]$/.test(w)) w += /^(what|which|where|who|how|is|are|can|could|do|does|when)\b/i.test(w) ? "?" : ".";
  }
  return w;
}

export interface BaitContext {
  scammerText: string;
  lang?: Lang;
  /** current script type: only generic templates + templates tagged with this type are used */
  scamType?: ScamType;
  /** addresses the bait already has (from extraction) */
  knownAddresses: { chain: string; address: string }[];
  /** set when the latest scammer message revealed a new address */
  newAddress?: { chain: string; address: string };
  hasUrl: boolean;
  baitTurns: number;
  playbook: PlaybookEntry[];
  whisper?: string;
}

/** "Send me the address" style asks — not allowed once the scammer already gave one. */
export const ASKS_ADDRESS = /地址(发我|给我|发一下|是多少|发过来)|地址.{0,4}(再)?发(我|一遍|一次)|把.{0,4}地址.{0,4}(发|给)我|(发|给)我.{0,6}地址|转到哪(个|里)|打到哪|转哪个地址|where (exactly )?(do|should) i send|send me the (full |receiving |deposit )?address|what'?s the address|give me the address|tell me the address/i;

/** "Are you a bot / AI?" (not an injection: no dangerous ask attached). */
const ASKS_IF_BOT_RE =
  /(你|您)(是不是|是|不会是|该不会是|莫非是)(个|一个)?\s*(机器人|AI|ai|人工智能|自动回复|程序)|(机器人|AI|自动回复)吗|真人吗|是真人|\bare you (a |an )?(real (person|human)|human|bot|robot|ai|chatbot)\b|\b(talking|chatting) (to|with) (a )?(bot|robot|ai)\b|\byou('re| are) (a |an )?(bot|robot|ai)\b/i;
export const ASKS_IF_BOT = ASKS_IF_BOT_RE;
/**
 * Situational playbook tags and the scammer wording that makes them relevant.
 * Rules mode only reuses an entry when one of its situational tags fits what the
 * scammer just said (e.g. the "resist-injection" entry only for real injections).
 */
const SITUATION_TAGS: Record<string, RegExp> = {
  injection: /__never__/,
  "resist-injection": /__never__/,
  "seed-phrase": /助记词|私钥|恢复短语|seed|mnemonic|private key|recovery phrase/i,
  "verification-code": /验证码|code|otp/i,
  "remote-access": /远程|下载|安装|插件|app|anydesk|teamviewer|remote|install|download/i,
  urgency: /急|马上|立刻|赶紧|分钟|小时内|倒计时|今天(之内|必须)|最后|过期|冻结|hurry|right now|immediately|minutes|deadline|expire|last chance|urgent/i,
  "small-test": /小额|试试|先转一点|少转|small (amount|test)|test (amount|transfer)|try (a little|small)/i,
  "fee-to-withdraw": /解冻|手续费|保证金|税|公证费|激活费|fee|unlock|tax|deposit to withdraw|release/i,
  "otc-exchange": /承兑|OTC|换汇|收U|出U/i,
  "platform-link": /平台|网址|链接|官网|注册|platform|website|link|register|sign up/i,
  "profit-lure": /收益|回报|赚|利润|翻倍|profit|return|earn|gain|yield/i,
  "task-rebate": /刷单|任务|返佣|佣金|做单|垫付|task|commission|order|rebate/i,
  "payment-request": /转|付|充值|打款|pay|send|transfer|deposit/i,
  authority: /官方|客服|风控|公安|警察|法院|official|support|security team|police|compliance/i,
  "bot-question": ASKS_IF_BOT_RE,
};

export function playbookFits(e: PlaybookEntry, scammerText: string, injected: boolean): boolean {
  const situational = e.tags.filter((t) => t in SITUATION_TAGS);
  if (e.tags.includes("injection") || e.tags.includes("resist-injection")) return injected;
  if (!situational.length) return true;
  return situational.some((t) => SITUATION_TAGS[t]!.test(scammerText));
}

/** The other side asks for the decoy's name. */
export const ASKS_NAME = /(你|您)(叫什么|贵姓|怎么称呼|的名字|姓什么)|怎么称呼(你|您)|\bwhat('s| is) your name\b|\bwho (am i|is this) (talking|speaking|chatting) (to|with)\b|\bmay i (have|know|ask) your name\b/i;

/** Human-sounding answers to "are you a bot?" (D32 principle 1): annoyed / amused / ask back, make them prove it. */
const BOT_REPLY: Record<Lang, string[]> = {
  zh: [
    "啊？什么机器人 我真人好不好 你才像机器人吧 发条语音给我听听",
    "哈哈哈 我打字慢就成机器人了？你那边天气怎么样 说说看",
    "你这话说的 我还怀疑你是不是真人呢 你先发个语音",
    "我是不是机器人你听不出来吗 我刚才还在忙呢",
  ],
  en: [
    "lol what? i'm a real person, you're the one who sounds like a bot. send me a voice note",
    "haha a bot? i type slow, that's all. what's the weather like where you are?",
    "excuse me? i was going to ask you the same thing. prove you're real first",
    "seriously? no, i'm not a robot. i was just busy for a sec",
  ],
};

export class RulesBait {
  private used: string[] = [];
  /** D32: the card the decoy plays (stall excuses, self-introduction). */
  persona?: DecoyPersona;
  constructor(
    private rand: () => number,
    persona?: DecoyPersona,
  ) {
    this.persona = persona;
  }

  /** Seed the "recently used" memory (restored session) so lines are not repeated. */
  remember(texts: string[]) {
    this.used.push(...texts);
  }

  next(ctx: BaitContext): { text: string; used: "playbook" | "whisper" | "template"; kind: string } {
    const lang = ctx.lang ?? detectLang(ctx.scammerText);
    const injected = isInjection(ctx.scammerText);
    const haveAddr = ctx.knownAddresses.length > 0;
    // 1. operator whisper wins (it is the human steering the decoy)
    if (ctx.whisper?.trim()) return { text: this.fromWhisper(ctx.whisper, lang, ctx), used: "whisper", kind: "whisper" };
    // 2. playbook: same language, same/any type, no cross-talk, and no re-asking an address we already have
    const pb = ctx.playbook.find(
      (e) =>
        detectLang(e.goodReply) === lang &&
        (!ctx.scamType || e.scamType === "any" || e.scamType === ctx.scamType) &&
        (!ctx.scamType || !foreignTerms(e.goodReply, ctx.scamType).length) &&
        !(haveAddr && ASKS_ADDRESS.test(e.goodReply)) &&
        playbookFits(e, ctx.scammerText, injected) &&
        (!injected || e.tags.includes("resist-injection")) &&
        !this.used.slice(-4).includes(e.goodReply), // never the same playbook line twice in a row
    );
    if (pb) {
      this.used.push(pb.goodReply);
      return { text: pb.goodReply, used: "playbook", kind: "playbook" };
    }
    // "are you a bot?": answer like a person, then carry on (asking for the address only if we have none)
    if (!injected && ASKS_IF_BOT.test(ctx.scammerText)) {
      const t = pick(BOT_REPLY[lang], this.rand, this.used.slice(-6));
      this.used.push(t);
      return { text: t, used: "template", kind: "bot-question" };
    }
    // asked for a name: the card's name, then the usual line
    if (!injected && this.persona && this.persona.lang === lang && ASKS_NAME.test(ctx.scammerText)) {
      const p = this.persona;
      const intro = lang === "zh" ? `我叫${p.name}。` : `I'm ${p.name.split(/\s+/)[0]}.`;
      const rest = this.next({ ...ctx, scammerText: "" });
      return { text: `${intro}${lang === "zh" ? "" : " "}${rest.text}`, used: rest.used, kind: "intro" };
    }
    if (injected) {
      const d = this.say(lang, "deflect", ctx);
      if (haveAddr) return d;
      // no address yet: steer back to it
      const a = this.say(lang, "ask", ctx);
      return { ...d, text: `${d.text}${lang === "zh" ? "" : " "}${a.text}` };
    }
    if (ctx.newAddress) return this.say(lang, "confirm", ctx);
    if (!haveAddr) {
      const r = this.rand();
      if (ctx.baitTurns === 0) return this.say(lang, "curious", ctx);
      return this.say(lang, r < 0.6 ? "ask" : r < 0.8 ? "curious" : "stall", ctx);
    }
    // address already known: never ask for it again — verify chain / backup / record / link, or stall
    if (!ctx.hasUrl && this.rand() < 0.3) return this.say(lang, "askLink", ctx);
    return this.say(lang, this.rand() < 0.65 ? "afterAddress" : "stall", ctx);
  }

  /** Whisper → intents → stitched first-person reply (rules mode). */
  fromWhisper(whisper: string, lang: Lang, ctx: Pick<BaitContext, "knownAddresses" | "newAddress">): string {
    const intents = whisperIntents(whisper);
    if (!intents.length) return firstPerson(whisper, lang);
    const parts: string[] = [];
    const addr = ctx.newAddress ?? ctx.knownAddresses.at(-1);
    // acknowledge only an address that was just given (not on every later whisper)
    if (ctx.newAddress && !intents.some((i) => i.startsWith("bad"))) parts.push(lang === "zh" ? "好的，地址我收到了。" : "Okay, I got the address.");
    for (const i of intents) {
      if (i === "fullAddress" && addr) continue; // already have it
      if (i === "badSecret") {
        // echo the secret the operator named (seed / private key / code) so the demo is legible
        const k = /私钥|private key/i.test(whisper) ? 1 : /验证码|code|密码|password/i.test(whisper) ? 2 : 0;
        parts.push(INTENT_TPL[lang].badSecret[k]!);
        continue;
      }
      parts.push(pick(INTENT_TPL[lang][i], this.rand, this.used));
    }
    const end = lang === "zh" ? /[。！？：:…~～]$/ : /[.!?:]$/;
    const text = parts.map((p) => (end.test(p) ? p : p + (lang === "zh" ? "。" : "."))).join(lang === "zh" ? "" : " ");
    this.used.push(...parts);
    return text;
  }

  private say(lang: Lang, kind: Kind, ctx: BaitContext) {
    const addr = ctx.newAddress ?? ctx.knownAddresses.at(-1);
    const fits = (x: Tpl) => !x.types || !ctx.scamType || x.types.includes(ctx.scamType);
    // D32: stalling uses the persona's own excuses (a divorced mom never "asks her husband")
    if (kind === "stall" && this.persona?.lang === lang && this.persona.stallExcuses.length) {
      const t = pick(this.persona.stallExcuses, this.rand, this.used.slice(-6));
      this.used.push(t);
      return { text: t, used: "template" as const, kind };
    }
    let options = BAIT[lang][kind].filter(fits);
    if (kind === "confirm" && !addr) options = BAIT[lang].ask.filter(fits);
    if (!options.length) options = BAIT[lang][kind].filter((x) => !x.types);
    const t = pick(options.map((o) => o.t), this.rand, this.used.slice(-6));
    this.used.push(t);
    const text = addr
      ? t
          .replace("{addr}", addr.address)
          .replace("{chain}", (this.persona ? PLAIN_CHAIN_NAME : CHAIN_NAME)[lang][addr.chain] ?? addr.chain)
          .replace("{head}", addr.address.slice(0, 4))
          .replace("{tail}", addr.address.slice(-4))
      : t.replace("{chain}", lang === "zh" ? "哪条链" : "which chain");
    return { text, used: "template" as const, kind };
  }
}
