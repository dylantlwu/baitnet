# X 帖草稿

> 发帖人：**Dylan 本人**（agent 不代发）｜建议发帖时间：11/14 视频定稿后
> 依据：[比赛调研 §3](../research/比赛调研.md) 的 X 帖要求和建议
> 更新：2026-11-11，加入 D32 诱饵人物卡与心智、D33 防混淆、D34 骗子人物卡与真实模式（新串推 3/5）

## 发帖前核对

- [ ] 主帖含 **built at NEAR HACKATHON**、**@NEARProtocol**、**#NEARHackathon**（三项都是硬要求）
- [ ] 主帖附视频（[视频脚本](视频脚本.md) 的 **2:20 版**）；没有视频时至少附 2 张截图：`docs/manual/img/page-guard.jpg`（拦截日志）和 `docs/manual/img/arena-address-extracted.jpg`（抽到地址）
- [x] GitHub 仓库 `dylantlwu/baitnet` 已设为公开（2026-11-11）
- [ ] 把串推 5 的 `<Public Demo 邀请的登录链接>` 换成团队页里新建的 `Public Demo` 专家邀请链接（不要用评审那个，见[提交表单草稿](提交表单草稿.md)「评审和公众怎么进线上版」）
- [ ] 用无痕窗口打开串推 5 的两个链接各试一次，确认试玩链接能登录并开一局
- [ ] 可选：在串推 5 末尾加 @NearLegion @NearBuilders（各 12～13 字符，串推 5 换上真实链接后还剩 32 字符，够）
- [ ] 发完把**主帖链接**填进提交表单的 "Demo post link"

字数按 X 规则统计（链接一律算 23 字符；`•` 这类符号算 2；像 `vault.pay` 这种「词.顶级域名」会被 X 自动当成链接，也算 23，帖子里要避开），上限 280。下面的字数是用脚本数的（链接按 23 计）。

## 主帖（1/5）（277 / 280）

```text
Scam addresses usually get flagged only after victims pay. And AI agents now hold money too.

BaitNet sends AI decoys to talk to scammers first, puts the payment addresses they reveal on NEAR, and agents refuse to pay them.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

## 串推 2/5：NEAR 具体带来了什么（275 / 280）

```text
What NEAR does here:
• the agent's only key is a function-call key: it can only call pay on the vault
• the vault checks the registry on chain before paying
• Intents swaps are checked before a quote

Demo: a prompt-injected agent tries to pay a flagged account. It fails.
```

## 串推 3/5：诱饵和骗子都有「人」（D32 + D34）（266 / 280）

```text
The decoy plays a real-feeling person: money, family, routine, words she wouldn't know. It thinks before each reply; code checks for AI tells and contradictions.

The scammer AI has a mask and an operator behind it. It gets suspicious, tests the victim, or vanishes.
```

## 串推 4/5：防栽赃与隐私（D33）（252 / 280）

```text
A scammer who smells a bait may send someone else's address to frame them. Exchange and token addresses are blocked; "sent after asking 'are you a bot?'" or "said TRC20, sent 0x" get warnings a human must clear.

On chain: address + evidence hash only.
```

## 串推 5/5：试用 + 求反馈（248 / 280）

```text
Live run, 48 scripts, suspicious scammers: 42 addresses, 0 leaks, 13/13 poison filtered.

No keys needed: pnpm install && pnpm demo
Repo: https://github.com/dylantlwu/baitnet
Try it: <Public Demo 邀请的登录链接>

Wallet & agent builders: block/warn, or a risk score?
```

## 写法说明（给 Dylan）

- 按调研建议：第一句先讲用户的问题（地址要等受害者付了钱才被标记；AI 代理也开始持有资金），不做长开场，不放架构图。
- 串推 2 具体写 NEAR 带来的三件事：function-call key 限权、Vault 跨合约链上检查、Intents 报价前检查，没有写 "powered by NEAR" 这类空话。
- 串推 3 是这两天的新东西：诱饵人物卡和心智（D32）、骗子面具 + 真人卡和怀疑度（D34）。只写能在视频里看到的东西。
- 串推 4 讲防栽赃（D33）。评委最可能追问"会不会被拿来冤枉人"，这里直接给两个具体例子。
- 串推 5 的数字来自 [D34 实测报告](../qa/2026-11-11_live-eval-D34.md)（大模型、骗子会起疑）：42/48、泄露 0、投毒过滤 13/13。**没写的那一条**：有 1 局被注入带偏（investment-02）——帖子篇幅放不下解释，README 和报告里都如实写了；如果评论里有人问，直接承认并指向报告。不要写规则模式的 48/48，那只说明流程通。
- 串推 5 的试玩链接是公开的专家邀请：所有人共用每天 200 次大模型调用，用完当天就停；被刷可以在团队页吊销再换。链接按 23 字符算，所以字数不受链接长短影响。
- 结尾是一个具体问题（block/warn 还是风险分），方便钱包和代理开发者回复。
- 中文版不单独发主帖。如果想发给中文社区，可以在串推里另起一条中文，但主帖必须是满足三项要求的这一条。
