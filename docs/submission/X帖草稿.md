# X 帖草稿

> 发帖人：**Dylan 本人**（agent 不代发）｜建议发帖时间：11/14 视频定稿后
> 依据：[比赛调研 §3](../research/比赛调研.md) 的 X 帖要求和建议

## 发帖前核对

- [ ] 主帖含 **built at NEAR HACKATHON**、**@NEARProtocol**、**#NEARHackathon**（三项都是硬要求）
- [ ] 主帖附视频（[视频脚本](视频脚本.md) 的 2:20 版本）；没有视频时至少附 2 张截图：`docs/manual/img/page-guard.jpg`（拦截日志）和 `docs/manual/img/arena-address-extracted.jpg`（抽到地址）
- [ ] 把串推 4 里的两个占位链接换成真实的 repo 和托管 demo 地址（链接按 23 字符计，换完长度不变）
- [ ] 可选：在串推 4 末尾加 @NearLegion @NearBuilders（每个约 12 字符，当前余量够）
- [ ] 发完把**主帖链接**填进提交表单的 "Demo post link"

字数按 X 规则统计（链接一律算 23 字符），上限 280。

## 主帖（1/4）（277 / 280）

```text
Scam addresses usually get flagged only after victims pay. And AI agents now hold money too.

BaitNet sends AI decoys to talk to scammers first, puts the payment addresses they reveal on NEAR, and agents refuse to pay them.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

## 串推 2/4：NEAR 具体带来了什么（274 / 280）

```text
What NEAR does here:
• the agent's only key is a function-call key: it can call vault.pay, nothing else
• the vault checks the registry on chain before paying
• Intents swaps are checked before a quote

Demo: a prompt-injected agent tries to pay a flagged account. It fails.
```

## 串推 3/4：防投毒与隐私（243 / 280）

```text
Scammers try to poison the list: "go report this address" (it's an exchange hot wallet). Exchange, bridge and token addresses are filtered, and every alert needs human review.

On chain: address + evidence hash only. No names or phone numbers.
```

## 串推 4/4：试用 + 求反馈（246 / 280）

```text
Try it with no keys: pnpm install && pnpm demo
Repo: https://github.com/TBD/baitnet
Demo: https://tbd.example/baitnet

Question for wallet and agent builders: would you check a registry like this before signing, or do you need a score instead of block/warn?
```

## 写法说明（给 Dylan）

- 按调研建议：第一句先讲用户的问题（地址要等受害者付了钱才被标记；AI 代理也开始持有资金），不做长开场，不放架构图。
- 串推 2 具体写 NEAR 带来的三件事：function-call key 限权、Vault 跨合约链上检查、Intents 报价前检查，没有写 "powered by NEAR" 这类空话。
- 串推 3 主动讲投毒和隐私，因为评委最可能追问"会不会被拿来冤枉人"。
- 结尾是一个具体问题（block/warn 还是风险分），方便钱包和代理开发者回复。
- 不写评测分数：规则模式的 34/34 不能代表 AI 水平，写在帖子里容易被误读。
- 中文版不单独发主帖。如果想发给中文社区，可以在串推里另起一条中文，但主帖必须是满足三项要求的这一条。
