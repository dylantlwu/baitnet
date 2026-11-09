# 飞书 / Lark 适配计划（后端 C，11/12 开工）

目标：照 `packages/im/src/types.ts` 的 `ChannelAdapter` 写一个 `LarkAdapter`，`SessionRouter` 不改。飞书（open.feishu.cn）和 Lark（open.larksuite.com）是两套租户、两套开放平台，**同一份代码，起两个实例**（domain 不同）。

## 1. 每个租户要做的事（Dylan / 租户管理员）

1. 开发者后台 → 创建**企业自建应用**，开启「机器人」能力。
2. 申请权限（scope），提交版本，由**租户管理员审批**：

| 权限 | 用途 |
|---|---|
| `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息） | 收消息 |
| `im:message:send_as_bot`（以应用身份发消息） | 发文字、发卡片 |
| `im:message`（获取与发送单聊、群组消息） | 更新卡片（PATCH 消息） |
| `im:resource`（获取消息中的资源文件） | 下载截图、聊天记录文件 |
| `contact:user.base:readonly`（可选） | 读用户语言，决定中/英文；没有就飞书默认中文、Lark 默认英文 |

3. 事件与回调 → 订阅方式选「**使用长连接接收事件/回调**」，订阅事件 `im.message.receive_v1`，回调订阅 `card.action.trigger`（卡片按钮）。可选：`application.bot.menu_v6`（机器人菜单）。
4. 把 App ID / App Secret 放进服务器环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`LARK_APP_ID`、`LARK_APP_SECRET`。设了哪组就启动哪个实例。

## 2. 长连接怎么接

- 用官方 SDK `@larksuiteoapi/node-sdk`：`new WSClient({appId, appSecret, domain})` + `EventDispatcher().register({"im.message.receive_v1": …})`，卡片回调用同一个长连接（`card.action.trigger`）。不需要公网回调地址，香港服务器出站连接即可。tenant_access_token 由 SDK 自动续期。
- 选 SDK 而不是手写：长连接是自定义的 protobuf 帧 + 心跳 + 分片，手写不划算（Telegram 那边只是 HTTP，所以手写）。
- 去重：事件带 `header.event_id`，同 Telegram 一样记最近 1000 个；断线由 SDK 重连。
- 回调必须 3 秒内返回：路由里的按钮处理先 `answerButton`（返回 toast）再干活，和现在一致。

## 3. 消息映射

| 路由需要的 | 飞书 / Lark |
|---|---|
| `InMessage.user.externalId` | `event.sender.sender_id.open_id`（每个应用不同，所以两个租户的绑定互不冲突；`IdentityBinding.kind` 都记 `"lark"`） |
| `isPrivate` | `message.chat_type === "p2p"` |
| `text` | `message_type: "text"`，`content` 是 JSON `{"text": …}`；`post`（富文本）把文字段拼起来 |
| `images` | `message_type: "image"` 的 `image_key`；富文本里的多张图一起作为一组；连续单发的图片用和 media group 一样的 1.5 秒窗口合并 |
| `file` | `message_type: "file"` 的 `file_key` + `file_name` |
| `fetchFile` | `GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image|file` |
| `replyToMessageId` | `message.parent_id` |

## 4. 按钮 = 卡片

- 带按钮的消息一律发 `msg_type: "interactive"` 卡片；按钮元素 `{tag:"button", text, value: {p: payload}}`，回调里的 `action.value.p` 就是 payload（没有 64 字节限制，但保持同样的格式）。没按钮的发普通 `text`。
- `answerButton(toast)` → 回调响应里返回 `{toast: {type: "info", content}}`。
- `editButtons` / `editMessage` → `PATCH /open-apis/im/v1/messages/:message_id` 更新卡片（卡片 config 要带 `update_multi: true`）。普通文字消息不能改，所以向导、审核卡片都发成卡片。
- `forceReply`（✏️ 改写、/end 评语）没有对应物 → 发一张带**输入框表单**的卡片（`input` + 提交按钮），提交时 `action.form_value` 里带文字；路由的 pending 状态照旧兜底（直接回一句也行）。
- 审核卡片：改写卡片左右两栏（`column_set`）并排坏说法 / 好说法，比 Telegram 更好看。

## 5. 没有对应物的

| Telegram | 飞书 / Lark |
|---|---|
| `sendChatAction typing` | 没有"正在输入"API；`typing()` 做成空操作，停顿照样有。可选：给用户那条消息加一个表情回应再撤掉（需 `im:message.reactions:write`） |
| `setMyCommands` | 没有斜杠菜单 API；在开发者后台配置「机器人菜单」（/new、/status、/help），菜单事件转成同名命令；其余命令照样手打 |
| deep link `?start=码` | 没有启动参数；邀请页显示「打开机器人」applink + 让用户发 `/start 码` |
| media group | 见上：富文本多图或 1.5 秒窗口 |

## 6. 工作量与顺序（11/12）

1. `LarkAdapter`（长连接、文字/图片/文件、卡片按钮、PATCH 更新）——约半天；
2. 卡片模板（向导、诱饵消息的 👍👎✏️、审核卡片、输入框表单）——2 小时；
3. 用假的事件源做端到端测试（复用现在 e2e 用例，只换适配器）——2 小时；
4. 在飞书测试租户真机验证（需要管理员先审批权限）。

风险：权限审批要等管理员；Lark 国际版和飞书的 domain、限流（单聊每用户 5 QPS）各自独立，两边都要测一遍。
