# 零留存分析（D27，03 Privacy 赛道）

> 维护：后端 B2。代码在 `packages/scriptlab/src/ephemeral.ts`，端点是 `POST /scripts/analyze-ephemeral`。测试在 `packages/scriptlab/test/ephemeral.test.ts`。

## 1. 数据流

```
浏览器 ──HTTPS──▶ BaitNet 服务端（内存）
                    │ ① 解析 + 打码（本地，在内存里完成）
                    │ ② 规则引擎分析（本地，在内存里完成）
                    │ ③ 只把“打码后”的文本发出去
                    ▼
            NEAR AI Cloud 网关 ──▶ TEE 里的模型（OpenAI 兼容 /v1/chat/completions）
                    │ ④ 新 nonce → /v1/attestation/report → M10 逐项校验
                    │ ⑤ /v1/signature/<chat_id> → 校验回复签名
                    ▼
浏览器 ◀── ScriptAnalysis + {ephemeral: true, attestation}（只返回给浏览器）
```

- 模型从 `/v1/models` 里挑带 TEE 标记的模型。优先用 `NEARAI_MODEL`，前提是它带 TEE 标记。
- **截图不支持**：截图识别要用 Claude，而 Claude 不在 TEE 里运行，所以一律返回 422 `ephemeral-image`。
- **不会改用 Claude**：离线模式或没有 `NEARAI_API_KEY` 时，分析由本地规则引擎在内存中完成。attestation 用录制样例，标 `recorded: true`，warnings 第一条写明“未连接 NEAR AI Cloud，展示的是录制样例”。

## 2. 哪些东西不留

| 不留 | 怎么保证 |
|---|---|
| 原文 | 不写 `data/evidence/`：证据 hash 只在内存里计算，不会生成加密文件，也不会创建 `.key` |
| 打码版和分析结果 | 不读也不写 sqlite（`script_analyses`、`scripts` 等表）；也不写 arena 会话 |
| 日志 | 每次请求只记一行：`[scriptlab] 一次零留存分析，耗时 X ms`；报错信息里不回显对方返回的内容 |

**测试怎么证明**：
- 分析前后对 data 目录做文件快照（路径、大小、mtime、sha256），断言完全一致。
- spy `DatabaseSync.prototype.prepare` 和 `exec`，断言调用次数为 0。
- 断言日志和 console 里不出现样例原文中任何 4 个字符长的片段。
- 以上都在离线和 live（模拟的 NEAR AI Cloud）两种模式下，对中文和英文两份样例各测一遍。

**用户确认保存后才落盘**：前端让用户确认后，调用 `POST /scripts/analyses/:id/save {draft, analysis}`。服务端会：
1. 对传回来的 analysis 重新打码，因为它来自浏览器，不可信；
2. 去掉 `attestation` 和 `ephemeral` 字段；
3. 把打码后的公开记录封存成证据，然后存进库。

原文从来没有落盘，所以无法恢复。

## 3. 信任边界

**NEAR AI Cloud 网关能看到什么**
- 打码后的聊天文本，以及模型的回复。个人资料已经在 BaitNet 服务端换成 `[NAME_1]` 这类占位符，但骗子的收款地址和网址是情报，不打码。
- API key、来源 IP、请求时间和大小。
- 网关本身也有 attestation（`gateway_attestation`），M10 会逐项校验。但 TLS 在网关终止，所以“网关不留数据”要靠网关的 attestation 加上 NEAR AI 的声明，BaitNet 无法独立证明。

**BaitNet 服务端**
- 原文必然会在服务端内存里出现一次（打码要在服务端做）。“不留”的意思是：不写盘、不写库、不写日志，这几点有测试覆盖。
- 进程崩溃时的 core dump、操作系统的 swap 不在测试覆盖范围内。生产部署时应关闭 core dump 和 swap。

**attestation 能证明什么**
- 新 nonce 被绑定进 TDX quote 的 report_data（防重放）：这份报告是为这一次调用新生成的。
- quote 由 Intel DCAP 验证，GPU 证据由 NVIDIA NRAS 验证（都在线校验）。
- event_log 能重放出 RTMR3，compose hash 与 event_log 中记录的一致：TEE 里跑的是哪个镜像和配置。
- 回复签名：
  - 签名文本是 `sha256(请求体):sha256(响应体)`，校验时与这一次 `chat_id` 实际的请求体和响应体逐一比对；
  - 用 ECDSA personal_sign 恢复出签名者，要求等于 attestation 里模型的 `signing_address`。

**attestation 不能证明什么**
- 同一个模型的所有实例共用签名 key（M10 已知限制）。签名对得上，只能证明回复出自持有这把 key 的某个 TEE 实例，不能证明出自产生这份报告的那个实例。
- 证明不了网关和模型“之后”不留数据。attestation 只证明当时跑的代码和配置是什么，能不能留数据取决于这份代码本身。
- 证明不了 BaitNet 服务端自己不留数据：这一点靠开源代码和第 2 节的测试。
- 录制样例（`recorded: true`）只是用来展示流程，**不能**证明这一次分析是在 TEE 里跑的。界面上必须醒目标注。

## 4. 接口（给 B1 和前端）

- `POST /scripts/analyze-ephemeral`：请求体与 `/scripts/upload` 相同（支持 `files[]`，但不接受图片），也支持 `?lang=` 和 Accept-Language。返回 `ScriptAnalysis & { ephemeral: true; attestation: AttestationResult }`。
- 挂载时需要传入 M10 模块：
  ```ts
  registerScriptLabRoutes(router, { ...ctx, attestation: await import("./attestation.js") })
  ```
  不传时，attestation 里只有一条失败的检查项“M10 verifier not wired”。
- 环境变量：`BAITNET_MODE=live`、`NEARAI_API_KEY`，可选 `NEARAI_MODEL`、`NEARAI_BASE_URL`。

## 5. 额度与限流（后端 B1，apps/server）

- 鉴权开启（`BAITNET_AUTH=on`）时，这个端点只要求登录，**不写审计日志**，也不写任何额度记录。
- 为防止通过它无限消耗大模型额度，server 用**内存计数**：`已持久化的今日用量（auth.sqlite，来自竞技场等）+ 本进程内零留存调用次数 ≥ BAITNET_LLM_DAILY_LIMIT` 时返回 429 `daily LLM quota used up`。
- 另有单独限流：每人每分钟最多 5 次，超出返回 429。
- 内存计数在服务重启后清零（已接受的取舍：换来零落盘）。
- 鉴权关闭（本机 demo）时不做额度和限流。
- 测试：`apps/server/test/ephemeral.test.ts`（超额 429、限流 429，且 data 目录前后逐文件一致）。
