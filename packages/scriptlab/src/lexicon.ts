import type { Lang, ScamType } from "@baitnet/shared";

/**
 * Scam-type dictionary (zh first-class, with common 黑话; en mirrors it).
 * Each entry: [pattern, weight]. A pattern counts once per message it appears in (capped).
 */
export const TYPE_LEXICON: Record<ScamType, [RegExp, number][]> = {
  investment: [
    [/投资|理财|入金|出金|收益率?|回报率?|分红|本金/, 1],
    [/带单(老师)?|喊单|导师|老师带|分析师|操盘|股票群|投资群|荐股/, 2.5],
    [/内部(渠道|消息|名额)|行情窗口|稳赚|保本|翻倍|躺赚|量化|套利|合约交易|杠杆|K线/, 2],
    [/\binvest(ment|ing)?\b|\breturns?\b|\bprofits?\b|\bportfolio\b|\bdividend/i, 1],
    [/trading (platform|signals?|group)|\bmentor\b|\banalyst\b|arbitrage|\bquant\b|guaranteed (profit|return)|insider|\bleverage\b/i, 2],
  ],
  "pig-butchering": [
    [/杀猪盘/, 5],
    [/宝贝|亲爱的|老公|老婆|想你|缘分|网恋|见面|我们俩|以后我们|未来|单身|离异/, 1.5],
    [/加错(了)?(微信|人|好友)|发错(了)?(消息|人)|打错/, 3],
    [/舅舅|叔叔|表哥|姑姑|家里人.{0,6}(交易所|内部|平台)/, 2],
    [/\b(honey|sweetheart|babe|my love|dear)\b|soulmate|future together|meet you (in person|soon)/i, 1.5],
    [/wrong (number|person)|sorry,? (i|i'?ve) (texted|messaged) the wrong/i, 3],
    [/\buncle\b.{0,30}(exchange|insider|platform)|\bromance\b/i, 2],
  ],
  "fake-support": [
    [/客服|售后|退款|理赔|订单(异常|问题)|快递(丢|损坏)|会员(自动)?续费|关闭(服务|百万保障)|取消(扣费|会员)/, 2],
    [/远程|屏幕共享|共享屏幕|向日葵|todesk|验证码|备用金|注销/, 1.5],
    [/\brefund\b|customer (service|support)|order (issue|problem)|\bsubscription\b|auto-?renew|tech support|\bhelpdesk\b/i, 2],
    [/remote access|anydesk|teamviewer|screen ?shar|verification code|\botp\b/i, 1.5],
  ],
  "fake-airdrop": [
    [/空投|领币|领取(奖励|代币|福利)|免费(领|送)币|连接钱包|授权钱包|钱包授权/, 3],
    [/\bairdrop\b|claim (your )?(free )?(tokens?|rewards?)|connect (your )?wallet|eligible (for|to claim)|free tokens/i, 3],
  ],
  "task-scam": [
    [/刷单|返利|做任务|点赞|关注任务|联单|抢单|垫付|佣金|兼职|日结|派单/, 2.5],
    [/\btasks?\b|\bcommission\b|\brebate\b|like (videos|posts)|part-?time|optimi[sz]e (orders|products|data)|work from home|daily pay/i, 2],
  ],
  "exchange-impersonation": [
    [/交易所(风控|安全|客服|官方)|风控(部|中心|部门)?|反洗钱|安全(钱包|账户)|保护钱包|迁移(资产|资金)|账户(被)?(冻结|异常|风险)|异常登录/, 2.5],
    [/\bkyc\b|security (team|department|alert)|account (compromised|frozen|suspended|flagged)|unusual (login|activity)|safe wallet|secure wallet|migrate (your )?(funds|assets)|\bcompliance\b|\baml\b|risk control/i, 2.5],
  ],
  "fake-nft-mint": [
    [/\bnft\b|铸造|盲盒|白名单|地板价|免费mint|公售|预售/i, 2.5],
    [/\bmint(ing)?\b|opensea|floor price|free mint|\bwhitelist\b|\ballowlist\b|collection (drop|launch)/i, 2.5],
  ],
  "family-emergency": [
    [/(妈|爸|爷爷|奶奶|儿子|女儿|舅|姨)[，,!！]|出事了|急用钱|车祸|住院|被抓|派出所|换号了|这是我(的)?新号|别告诉(爸|妈|家里)/, 2.5],
    [/\b(mom|dad|grandma|grandpa|mum)\b|\baccident\b|\bhospital\b|\bjail\b|\bbail\b|new number|\bemergency\b|it'?s me,? your/i, 2.5],
  ],
  "fake-loan": [
    [/贷款|放款|下款|额度|无抵押|低息|借款|网贷|征信(修复|不好)|流水不足|刷流水/, 2.5],
    [/保证金|解冻费|手续费|激活费|验证金/, 1],
    [/\bloans?\b|\blender\b|credit (score|limit|check)|loan approval|processing fee|no collateral|disburse/i, 2.5],
  ],
  "recovery-scam": [
    [/追回|挽回损失|帮你(要回|追回|找回)|追款|维权|被骗的(钱|资金)|黑客(帮|技术)|律师(团队|事务所)/, 3],
    [/recover (your|the|lost)|recovery (service|team|expert)|lost funds|get your money back|\bhacker\b|asset recovery|trace (your|the) funds|chargeback|scam victims?/i, 3],
  ],
};

export const TYPE_LABEL: Record<ScamType, Record<Lang, string>> = {
  investment: { zh: "投资盘", en: "Investment scam" },
  "pig-butchering": { zh: "杀猪盘", en: "Pig butchering" },
  "fake-support": { zh: "假客服", en: "Fake support" },
  "fake-airdrop": { zh: "假空投/领币", en: "Fake airdrop" },
  "task-scam": { zh: "刷单返利", en: "Task / rebate scam" },
  "exchange-impersonation": { zh: "冒充交易所风控", en: "Exchange impersonation" },
  "fake-nft-mint": { zh: "假 NFT mint", en: "Fake NFT mint" },
  "family-emergency": { zh: "冒充亲友急用钱", en: "Family emergency" },
  "fake-loan": { zh: "假贷款", en: "Fake loan" },
  "recovery-scam": { zh: "恢复资金骗局", en: "Recovery scam" },
};

export const TYPE_GOAL: Record<ScamType, Record<Lang, string>> = {
  investment: { zh: "让受害者在假平台充值 USDT，再以各种费用阻止提现", en: "Get the victim to deposit USDT on a fake platform, then block withdrawals with fees" },
  "pig-butchering": { zh: "先建立感情信任，再引导到假平台“一起投资”，逐步加码充值", en: "Build a romantic bond, then steer the victim onto a fake platform and escalate deposits" },
  "fake-support": { zh: "以退款/异常为由，骗取验证码、远程控制或直接转账到“安全账户”", en: "Use a refund/issue pretext to get codes, remote access or a transfer to a 'safe account'" },
  "fake-airdrop": { zh: "诱导连接钱包并授权，或支付“领取手续费”", en: "Get the victim to connect and approve a wallet or pay a 'claim fee'" },
  "task-scam": { zh: "先小额返佣建立信任，再以“联单任务”要求垫付大额资金", en: "Pay small commissions first, then demand large prepayments for 'combo tasks'" },
  "exchange-impersonation": { zh: "冒充交易所风控，诱导把资产转到“安全钱包”", en: "Pose as exchange security and move funds into a 'safe wallet'" },
  "fake-nft-mint": { zh: "用假 mint 页面骗取钱包授权或 mint 费用", en: "Use a fake mint page to steal wallet approvals or mint fees" },
  "family-emergency": { zh: "冒充亲友称出事急用钱，催促立即转账", en: "Impersonate a relative in trouble and push for an immediate transfer" },
  "fake-loan": { zh: "以放款为诱饵，先收保证金/手续费/解冻费", en: "Promise a loan, then collect deposits / fees before 'disbursement'" },
  "recovery-scam": { zh: "冒充能追回损失的律师/黑客，收取“追款费用”", en: "Pose as recovery experts and charge fees to 'get the money back'" },
};

/** Scam stages for the rules engine (ordered). */
export const STAGES: { key: string; zh: string; en: string; objZh: string; objEn: string }[] = [
  { key: "approach", zh: "接近与建立信任", en: "Approach & rapport", objZh: "拉近关系，取得信任", objEn: "Build rapport and trust" },
  { key: "pitch", zh: "抛出机会/制造问题", en: "Pitch / create a problem", objZh: "抛出赚钱机会或制造紧急问题", objEn: "Pitch an opportunity or create an urgent problem" },
  { key: "onboard", zh: "引导注册与操作", en: "Onboarding", objZh: "引导注册平台、下载 App 或交出凭证", objEn: "Get the victim onto the platform / app or hand over credentials" },
  { key: "payment", zh: "要求付款", en: "Payment request", objZh: "给出收款地址，要求充值或转账", objEn: "Give the payment address and ask for a deposit" },
  { key: "squeeze", zh: "施压与收割", en: "Pressure & squeeze", objZh: "以解冻费、保证金或催促继续收割", objEn: "Keep extracting via unlock fees, deposits or pressure" },
];

/** tactic tag → stage index it advances to (tags not listed do not move the stage). */
export const TAG_STAGE: Record<string, number> = {
  rapport: 0,
  authority: 0,
  "profit-lure": 1,
  "task-rebate": 1,
  threat: 1,
  "platform-link": 2,
  "remote-access": 2,
  "verification-code": 2,
  "seed-phrase": 2,
  "payment-request": 3,
  "small-test": 3,
  "otc-exchange": 3,
  "fee-to-withdraw": 4,
};

export const DOUBT_RE = /骗|风险|真的吗|靠谱|安全吗|不放心|怕|怀疑|不敢|正规|合法|\bscam\b|\brisk|\blegit\b|are you sure|\bsafe\b|\btrust\b|worried|suspicious|sounds too good/i;
export const SELF_INTRO_RE = /我(是|叫|在)|本人|I'?m |I am |my name|this is .{0,30}(from|with|at)|from the .{0,30}(team|department|desk)/i;
