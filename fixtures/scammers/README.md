# 骗子真人卡（D34）

`{zh,en}.json` 各 3 张 `ScammerCard`（定义见 `packages/shared/src/index.ts`，设计见 `docs/design/骗子人物卡.md`）。

真人卡写的是**键盘后面真正打字的人**：在哪种窝点干活、业绩压力、照不照话术念、会露哪些马脚、什么情况下怀疑对方是诱饵 / AI / 警察、怎么试探、起疑后怎么做、底线。它和剧本里的 `cover`（面具，骗子对受害者自称的身份）是两层：同一张真人卡可以戴不同剧本的面具。

全部是根据公开报道拼出来的**虚构人物**，不对应任何真实的人。

| id | 语言 | 原型（公开报道中的常见情形） | 覆盖的骗局类型 |
|---|---|---|---|
| `zh-compound-rookie` | zh | 被高薪招聘骗进缅北园区的新人，有加人和开单指标，护照被扣 | pig-butchering、investment、task-scam、fake-nft-mint、liquidity-mining |
| `zh-callcenter-veteran` | zh | 柬埔寨窝点里冒充公检法的「二线民警」，一线 / 二线 / 三线分工 | authority-impersonation、exchange-impersonation、fake-support、recovery-scam、family-emergency |
| `zh-otc-runner` | zh | 跑分「车队」的车头，在 Telegram / QQ 群招车手洗钱 | otc-mule、fake-loan、fake-airdrop |
| `en-hustle-house` | en | 西非合租屋里的 romance 骗子（"Yahoo boys" 一类），也招钱骡 | pig-butchering、family-emergency、recovery-scam、fake-loan、otc-mule |
| `en-compound-english-desk` | en | 被假工作骗进东南亚园区「英文组」的外籍劳工，用写作工具润色 | investment、task-scam、liquidity-mining、fake-nft-mint、fake-airdrop |
| `en-callcenter-imposter` | en | 小型呼叫中心的 closer，冒充 FBI / IRS / 交易所 / 技术支持 | authority-impersonation、exchange-impersonation、fake-support、recovery-scam |

每种语言的 3 张卡合起来覆盖全部 13 种 `ScamType`。

## 字段约定

- **写事实，不写形容词**（同诱饵人物卡）：「每天要加满 30 个新好友，没加够罚站到凌晨 4 点」，而不是「压力很大」。
- **`tests`**：规则引擎会把其中一条**原样**当作骗子的一句聊天发给对方，所以每条都要写成骗子会真的打出来的话，用这张卡的语言和口气（例如「你拍张自拍给我嘛，手里拿张纸写上今天的日期」），不要写成「要求发带日期的自拍」这种描述。
- **`onSuspicion`**：按怀疑度从低到高排的简短描述（不会发给对方）；最后一步是给一个不相干的地址（别人的地址或交易所大户钱包）或者直接消失，对应剧本里的 `poison` 和 `vanish`。
- **`slips`、`suspicionTriggers`**：分别是骗子自己会露的马脚、会让他起疑的诱饵行为。后者也是诱饵训练的反面教材。
- 卡里不出现真实人名、真实电话、真实网址或地址。

## 选卡

按剧本的 `type` 和 `lang`，在 `fitsScamTypes` 包含该类型的卡里用 session id 哈希稳定地选一张；剧本里写了 `scammerId` 就用指定的那张。

## 可见范围

真人卡、面具和骗子心智只给登录的团队成员看，**绝不进诱饵一侧的提示**。
