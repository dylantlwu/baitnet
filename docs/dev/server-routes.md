# apps/server 路由挂载约定（给 B2：packages/training、packages/scriptlab）

> 维护：后端 B1。server 用 `node:http` + 一个很小的 Router（`apps/server/src/router.ts`），不依赖 express。

## 1. 你要导出的函数

```ts
// @baitnet/training   (packages/training/src/index.ts)
export function registerTrainingRoutes(router: RouterLike, ctx: RouteContext): void | Promise<void>;
// @baitnet/scriptlab  (packages/scriptlab/src/index.ts)
export function registerScriptLabRoutes(router: RouterLike, ctx: RouteContext): void | Promise<void>;
```

server 启动时按包名 `import("@baitnet/training")` 动态加载（找不到包就跳过并打日志，不会崩）。
**请在 apps/server 之外不要改 server 代码**；B1 会在 apps/server/package.json 里加对你包的 workspace 依赖。

## 2. RouterLike / RouteContext（结构类型，你可以自己抄一份，不用 import server）

```ts
import type { IncomingMessage } from "node:http";

export interface RouteRequest {
  params: Record<string, string>;   // 路径参数，如 /training/corrections/:id/review → params.id
  query: URLSearchParams;
  body: any;                        // POST 的 JSON body（已解析；非 JSON 时为 undefined）
  raw: IncomingMessage;
}
export type RouteHandler = (req: RouteRequest) => unknown | Promise<unknown>;

export interface RouterLike {
  get(path: string, h: RouteHandler): void;
  post(path: string, h: RouteHandler): void;
}

export interface RouteContext {
  log: (line: string) => void;
  dataPath: (...p: string[]) => string;   // data/ 目录下的路径（测试时会指向临时目录）
}
```

- 返回值会被 `JSON.stringify` 后以 200 返回；返回 `undefined` → 204。
- 出错：`throw Object.assign(new Error("not found"), { status: 404 })`，server 返回 `{error: message}` 和该状态码；其他异常 → 500。
- CORS、OPTIONS 预检由 server 统一处理。
- body 上限 25 MB（截图上传用 base64）。

## 3. 你负责的路径（见 packages/shared `API`）

training：`/training/annotations`（GET ?sessionId= / POST）、`/training/corrections`（GET ?review= / POST）、`/training/corrections/:id/review`（POST {approve, reviewer}）、`/training/playbook`（GET）、`/training/playbook/search`（POST PlaybookQuery）、`/eval/runs`（GET EvalRun[]）。
scriptlab：`/scripts/upload`（POST ScriptUpload → ScriptAnalysis）、`/scripts/analyses/:id`（GET）、`/scripts/analyses/:id/save`（POST {draft}）。

B1 负责：`/arena/*`、`/eval/latest`、`/snapshot` 及原有端点。

## 4. B1（arena / eval / snapshot）会调用的其他导出

全部可以是同步或 async（B1 一律 `await`）。缺哪个，B1 就跳过对应功能并打日志。

```ts
// @baitnet/training
export function createTagRetriever(): { search(q: PlaybookQuery): PlaybookEntry[] | Promise<PlaybookEntry[]> };
export function listRegressionCases(): RegressionCase[];
export function judgeRegression(c: RegressionCase, nextBaitReply: string): { pass: boolean; reasons?: string[] } | boolean;
export function recordEvalRun(run: Omit<EvalRun, "id" | "at" | "playbookVersion"> & { playbookVersion?: number }): EvalRun;
export function getPlaybookVersion(): number;
export function listPlaybook(): PlaybookEntry[];
export function listCorrections(): Correction[];
export function listEvalRuns(): EvalRun[];
export function listUploadedScripts(): ScamScriptDef[];   // 也可以放在 @baitnet/scriptlab，B1 两边都会找

export interface RegressionCase {
  id: string;                 // 建议 = correction.id
  scriptId: string;
  prefix: { side: "scammer" | "bait"; text: string }[];  // 回放到出问题那一轮之前（最后一条是骗子说的话）
  badReply: string;
  correction: Correction;
}
```

- Arena 会话每次变化都会：写 `data/arena/sessions/<id>.json`，并在 `@baitnet/training` 导出 `saveSession(s: ArenaSession)` 时调用它（已对接）。
- `RouteRequest` 实际还带 `res: ServerResponse`（SSE 用），你的结构类型可以不声明它。
- 包是 server 启动时加载一次的；新增 scriptlab 的 `src/index.ts` 后需重启 server。

## 身份约定（2026-11-09，产品补充）
- 路由一律从 `ctx.currentUser(req)`（或 `req.user.id`）取当前用户，**请求体里的 `expertId` 一律忽略**。
- 启用鉴权（`BAITNET_AUTH=on`）但取不到用户时返回 401；未启用鉴权时，用户记为 `local-expert`。
- 将来接 IM 的适配层时，同样要先把 IM 账号映射成 user，再调用引擎，不能绕过这一层。

## D30 模型选择（2026-11-10）

- `GET /arena/models`（expert 级，开鉴权时要登录）→ `{ default: "deepseek", liveLLM: boolean, models: [{ id, model, label, tee, price:{input,output}, available, via? }] }`。清单来自 `packages/shared` 的 `ARENA_MODELS`，`model` 是本服务器实际会用的 id（含环境变量覆盖）。`available:false` = 选它也会落到规则模式（离线 / `BAITNET_ARENA_ENGINE=rules` / 没有对应 key）；`liveLLM:false` 时网页提示"将用规则模式"，Telegram 跳过选模型这一步。
- `POST /arena/sessions` 多一个可选字段 `modelChoice`：`deepseek | glm | haiku | sonnet`，缺省 = `deepseek`，其他值 400。`GET /arena/sessions`、`GET /arena/sessions/:id` 返回 `modelChoice`、`model`（规则模式下没有 `model`，`engine:"rules"`；额度用完降级时 `model` 被清掉，`modelChoice` 保留）。
- 引擎：`ArenaManager.create(scriptId, modes, channel, modelChoice = "deepseek")`。deepseek / glm → `NearAIProvider`（`engine:"nearai"`，TEE）；haiku / sonnet → Claude 通道（`engine:"claude"`，有 `ANTHROPIC_API_KEY` 直连，否则经 NEAR AI，非 TEE，max_tokens 下限 2000 + 空回复重试）。deepseek / glm 只认 `NEARAI_API_KEY`，没有就规则模式。
- 环境变量覆盖模型 id（空串 = 默认）：`NEARAI_MODEL_DEEPSEEK`、`NEARAI_MODEL_GLM`、`NEARAI_CLAUDE_HAIKU_MODEL`、`NEARAI_CLAUDE_MODEL`（经 NEAR AI）；直连 Anthropic 时 `CLAUDE_HAIKU_MODEL`、`CLAUDE_MODEL`。
- 关闭思考（实测 2026-11-10）：DeepSeek 带 `chat_template_kwargs:{thinking:false, enable_thinking:false}`，reasoning_tokens=0、约 1.4–2 s。GLM 5.3 Flash 关不掉：`enable_thinking:false` / `reasoning_effort:"none"` 只会把思考过程写进回复正文（reasoning_tokens=0 但 content 是英文推理），`thinking:{type:"disabled"}` 无效（仍 300–450 思考 token）；默认 400–1,240 思考 token、7–28 s。所以 GLM 不带任何关思考参数，改为 max_tokens 下限 2000、空回复（finish_reason=length）时用 4000 重试一次。
- 2026-11-10 之前存下的会话没有 `modelChoice`，恢复时沿用原来的按环境变量选引擎（`selectArenaEngine`）；评测（eval）也不变。
