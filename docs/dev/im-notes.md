# packages/im 说明（后端 C，2026-11-09）

设计见 [../03_IM训练台设计.md](../03_IM训练台设计.md)，接口约定见 [im-contract.md](im-contract.md)。

## 1. 结构

| 文件 | 作用 |
|---|---|
| `src/types.ts` | `ChannelAdapter`（渠道无关接口）、`ImDeps`、`IdentityService`、`ChatSessionStore` |
| `src/telegram/api.ts` | Bot API 客户端（直接用 fetch，约 100 行）：网络错误 / 5xx / 429 自动重试（遵守 retry_after），错误信息里的 token 一律替换成 `<token>` |
| `src/telegram/adapter.ts` | `TelegramAdapter`：getUpdates 长轮询；offset 持久化 + 最近 1000 个 update_id 去重；断网指数退避 1→30 秒；media group 合并成一条消息；401 时停止轮询 |
| `src/router.ts` | `SessionRouter`：命令、/new 向导、两种扮演、模拟真人、👍👎✏️⭐、耳语、/mode、/end 打分、审核卡片、上传、每日小结 |
| `src/state.ts` | 路由需要跨重启记住的小状态（`data/im/state-telegram.json`，不含 token）；`MemoryChatSessionStore` / `FileChatSessionStore` |
| `src/memory-identity.ts` | 内存版 IdentityService（dev 脚本和测试用） |
| `src/wiring.ts` | `scriptlabFromModules()`：把 `@baitnet/scriptlab` 包装成 `ImDeps.scriptlab` |
| `scripts/dev.ts` | 独立运行：`pnpm --filter @baitnet/im run dev`；冒烟：`run smoke`（只调 getMe + setMyCommands） |

不用 grammy：用到的 API 只有 10 个，fetch 足够，少一个依赖，也方便以后照抄成 Lark 版。

## 2. 后端 B 接线（apps/server）

```ts
import { startIm, scriptlabFromModules } from "@baitnet/im";
// arena.restore() 照旧在 ready 时调用
const im = await startIm({
  identity,                       // 你的 IdentityService（含 quota(userId)，/status 显示“已用 / 上限”）
  chats,                          // 你的 ChatSessionStore
  arena,                          // 同一个 ArenaManager
  training: await import("@baitnet/training"),
  scriptlab: scriptlabFromModules(await import("@baitnet/scriptlab"), { registry, log }),  // 传 registry 才能在 IM 里审核上传抽到的地址
  publicUrl: process.env.BAITNET_PUBLIC_URL!,
  log,
});
// 关闭时：await im.stop();   im.bot?.username 可用来生成 Invite.telegramStartUrl
```
没有 `TELEGRAM_BOT_TOKEN` 时 `startIm` 只打一行日志、返回空的 stop()，不会抛错；启动时连不上 Telegram 也不抛错，轮询自己重试。

需要在 `apps/server/package.json` 加 `"@baitnet/im": "workspace:*"`。

## 3. 需要后端 B 配合

1. 已用 B 加的公开方法：/end 调 `eng.finish()`；额度由 ArenaManager 的 `llmQuota` 闸门按会话 owner 在每次大模型调用前扣（IM 建会话时把 `channel` 传给 `arena.create`），用完后引擎自己 `setEngine("rules")` 并发 `safety`/`llm-quota-exceeded` 事件，IM 收到后告诉专家一次。IM 自己不再重复扣额度（只有截图上传时扣一次）。
2. ⭐ 生成的 Correction 的 `badReply` 为空串（示范型条目，B2 已放开），打标签 `expert-demo`。
3. 审核者卡片按 `reviewers("telegram")` 推送；Telegram 私聊的 chatId 等于用户 id，所以 reviewer 没给机器人发过消息也能收到（前提是他按过 /start）。
4. 审计 action 名：`im.bind`、`im.session.create`、`arena.say`、`arena.whisper`、`arena.mode`、`arena.end`、`arena.rate`、`training.annotate`、`training.correction`、`training.review`、`alert.review`、`scripts.upload`、`scripts.save`、`im.quota.downgrade`、`im.denied`（expert 越权点审核按钮）。
5. IM 会话的 `session.channel = {kind:"telegram", chatId, ownerId, expertPlays}` 已写入，后台可以按渠道筛选。

## 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | 设了才启动；只放服务器环境变量或 .env |
| `BAITNET_IM_DELAY_SCALE` | 1 | 打字停顿倍数；0 = 不停顿（测试），0.3 = 快速演示 |
| `BAITNET_IM_POLL_SEC` | 25 | 长轮询超时 |
| `BAITNET_IM_MEDIA_GROUP_MS` | 1500 | 相册最后一张到达后等多久再合并 |
| `TELEGRAM_API_BASE` | api.telegram.org | 测试或自建 Bot API 服务器时用 |
| `IM_DEV_INVITES` | 随机 | 仅 dev 脚本：`码:名字:角色,…` |

## 5. 交互要点

- 未绑定：只认 `/start 码`；其他消息最多回一次"请先用邀请码绑定"；按钮静默；群聊全部忽略；同一账号每天输错 5 次后不再回复。
- 专家扮骗子 → 机器人是诱饵「小林」；扮诱饵 → 骗子 AI 先开口，第一条前面一句"（我是：人设）"。
- AI 的每句都先"正在输入"，按长度停 2–8 秒（每 4 秒续一次 typing），长回复约 45% 概率在句子边界拆成两条。
- `/mode`：🤖 AI 自己说（耳语给你这一方的 AI）、✋ 我接管、👀 只看（耳语给诱饵）；AI 对 AI 每 6 句停下来问"▶ 继续"，避免烧额度。
- 上传：每人每天第一次上传前先发隐私提醒，点「继续分析」才分析；截图需要线上模式 + Claude key（scriptlab 的限制），否则提示改发 txt/json。
- 每天 9:00–11:59（上海时间）之间第一次检查时给 reviewer 推小结，一天一次。
