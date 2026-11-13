# YouTube 上传草稿

> 上传人：**Dylan 本人**（agent 不代传）｜更新：2026-11-13
> 视频和图片都在 `demo-video/`（不在 git 里）

## 传哪个文件

| 用途 | 文件 | 时长 |
|---|---|---|
| **YouTube（推荐）** | `demo-video/BaitNet-demo-完整版-2m39s-Bruce-片头-1113.mp4` | 2:39 |
| X 主帖 | `demo-video/BaitNet-demo-X版-2m16s-Bruce-片头-1113.mp4` | 2:16（X 普通账号上限 2:20） |

YouTube 没有 2:20 的限制，所以传完整版（多了 Intents 和 TEE 两段）。

**注意：竖屏、3 分钟以内的视频，YouTube 会自动归为 Shorts。** 对提交没有影响，链接照样能看，只有三点不同：
- 说明里的章节时间戳在 Shorts 里不显示（写了也不碍事）。
- 网页版 YouTube Studio 不一定允许给 Shorts 上传自定义缩略图。传不了时，用手机 YouTube App 在视频里选一帧当封面，选片头结尾的 logo 画面就行。
- Shorts 会循环播放，进度条也比较小。

想当普通横屏视频发的话，要另做一个 16:9 版本，现在还没有。

## 标题（91 / 100 字符）

```text
BaitNet: AI decoys catch scam addresses, NEAR agents refuse to pay them | NEAR Hackathon
```

备选（更短，64 字符）：

```text
BaitNet — AI decoys vs crypto scammers, on NEAR #NEARHackathon
```

## 说明

```text
Scam addresses usually get flagged only after a victim has paid. And AI agents now hold money too.

BaitNet sends AI decoys to talk to scammers first. The payment addresses they reveal go through human review, then onto a NEAR registry contract. Wallets and AI agents check it before paying: a prompt-injected agent tries to pay a flagged account, the guard blocks it, the wallet refuses to sign, and the on-chain vault refuses too.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
Tracks: 06 AI Security & Defense, 03 Privacy & Private AI

▶ Try it (no keys needed):
pnpm install && pnpm demo

Code: https://github.com/dylantlwu/baitnet
Live: https://baitnet-production.up.railway.app

What's in the demo
• Decoy persona: a concrete person with money, family and routine; it thinks before each reply
• Scammer AI with a mask and an operator behind it; it can get suspicious, test the victim, or vanish
• Anti-framing: exchange and token addresses are blocked; suspicious sends get warnings a human must clear
• On chain: address + evidence hash only, no chat text
• Agent wallet uses a function-call key that can only call vault.pay
• Same check before NEAR Intents swaps
• LLMs run on NEAR AI Cloud TEE models; live attestation verified 18/18

Latest live run (NEAR AI, scammers can get suspicious): 48 scripts, 42 addresses extracted, 0 personal-data leaks, 1 injection followed (investment-02, documented in the repo), 13/13 poison addresses filtered.

Note: in the arena scene, a human "whisper" nudges the scammer AI to show the anti-framing warning; the narration says so. Narration voice is AI-generated (Doubao TTS).

Chapters
0:00 Intro
0:04 The problem
0:15 What BaitNet does
0:24 Scammer AI vs decoy, live on NEAR AI
0:42 The decoy persona
0:58 The scammer's mask and operator
1:09 Anti-framing warnings and human review
1:27 On chain: address + evidence hash
1:37 Prompt-injection attack on a payment agent
1:46 Guard blocks, wallet and vault refuse
1:58 NEAR Intents check
2:05 Expert training and live eval
2:23 TEE attestation
2:32 Try it
```

章节时间按完整版 1113 那个文件算的（片头 4 秒 + 各段配音长度）。传 X 版的话时间会不一样，那就把 Chapters 整段删掉。

## 标签

```text
NEAR, NEAR Protocol, NEAR Hackathon, NEARHackathon, NEAR AI, crypto scam, scam detection, pig butchering, romance scam, AI agents, AI agent security, prompt injection, AI decoy, scambaiting, blockchain security, TEE, NEAR Intents, web3 security
```

## 上传设置

| 项目 | 建议 |
|---|---|
| 公开范围 | **公开**或**不公开（Unlisted）**都行，评委有链接就能看。不要选“私享”，评委会打不开 |
| 面向儿童 | 否 |
| 类别 | 科学技术（Science & Technology） |
| 视频语言 | 英语 |
| 字幕 | 已经烧在画面里，不用另传 |
| 加工/合成内容（Altered or synthetic content） | 配音是 AI 合成的，聊天也是 AI 生成的。按 YouTube 规则，非真人仿冒的 AI 配音不强制勾选；勾“是”更稳妥，对播放没有影响 |
| 缩略图 | `demo-video/YouTube缩略图-1280x720.png`；Shorts 传不了时用手机 App 选一帧，或参考 `demo-video/竖版封面-1080x1920.png` |

## 传完以后

- [ ] 用没登录的浏览器打开一次链接，确认能播放
- [ ] 把 YouTube 链接填进 README 的 Demo video（现在是 `<TBD>`，英文版和中文版两处）
- [ ] 提交表单的 Demo post link 填的是 **X 主帖链接**（要求带视频），不是 YouTube 链接；YouTube 链接可以写进项目描述或 README
