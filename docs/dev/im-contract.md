# IM 接入的内部接口约定（产品定，2026-11-09）

设计见 [../03_IM训练台设计.md](../03_IM训练台设计.md)；共用类型见 `packages/shared` 中的 `ChannelKind`、`User`、`IdentityBinding`、`SessionChannel`、`ExpertPlays`。

## 分工
- **后端 C**（`packages/im`）：负责渠道适配层、会话路由、Telegram 适配器（11/10–11/11），之后是飞书/Lark 适配器（11/12）。
- **后端 B**（`apps/server` 和 `packages/arena`）：实现下面的 `IdentityService` 和 `ChatSessionStore`；在 server 启动时，如果设置了 `TELEGRAM_BOT_TOKEN` 就调用 `startIm(deps)`。
- 后端 C 开发时先对着这里的接口写内存版假实现，两边各自测试，最后由后端 B 接线。

## 后端 B 提供（server 侧实现，注入给 im）

```ts
interface IdentityService {
  /** 用邀请码绑定 IM 账号；码无效、已撤销时返回 null。同一个码可以绑定同一个人的多个 IM 账号。 */
  bindByCode(kind: "telegram" | "lark", externalId: string, username: string | undefined, code: string): Promise<User | null>;
  userByBinding(kind: "telegram" | "lark", externalId: string): Promise<User | null>;
  /** 用来推送审核卡片：返回所有绑定了该渠道的 reviewer。 */
  reviewers(kind: "telegram" | "lark"): Promise<{ user: User; externalId: string }[]>;
  /** 调一次大模型前先调用；返回 false 表示超出今日额度，这个会话要降级成规则模式。 */
  consumeLlmQuota(userId: string): Promise<boolean>;
  audit(entry: Omit<AuditEntry, "at">): Promise<void>;
}

interface ChatSessionStore {          // 持久化：服务重启后不会丢
  get(kind: ChannelKind, chatId: string): Promise<string | undefined>;   // 返回 sessionId
  set(kind: ChannelKind, chatId: string, sessionId: string): Promise<void>;
  clear(kind: ChannelKind, chatId: string): Promise<void>;
}

interface ImDeps {
  identity: IdentityService;
  chats: ChatSessionStore;
  arena: ArenaManager;            // 现成的：create / say / whisper / step / mode / rate / review / 订阅事件
  training: typeof import("@baitnet/training");   // 现成的：annotation / correction / review / playbook
  scriptlab: { analyzeUpload: (u: ScriptUpload) => Promise<ScriptAnalysis>; save: (...) => ... };
  publicUrl: string;              // 用来生成后台链接
}

export function startIm(deps: ImDeps): Promise<{ stop(): Promise<void> }>;
```

## 必须遵守的规则
1. **白名单**：没绑定的账号只能用 `/start <码>`，发其他任何消息一律不回复（最多回一次"请先用邀请码绑定"，之后不再理会），避免被路人或真骗子利用。
2. **身份**：会话、改写、标注、上传的 owner 和 expertId 都取自 `userByBinding`，不能信任消息内容里写的名字。
3. **权限**：只有 reviewer 能审核改写、复核地址上链；expert 点这些按钮时，提示"等审核者处理"。
4. **只训练诱饵**（D15）：专家扮诱饵时，⭐ 存下的是诱饵一方的好话术；骗子 AI 不从专家那里学。
5. **隐私**：在 IM 里上传之前，先发一次提醒，说明内容会经过 Telegram 或飞书的服务器，含真实个人资料的请改用网页上传；每个用户每天提醒一次。
6. **额度**：超出额度时会话自动转为规则模式，并告诉专家"今日大模型额度已用完，已切换到规则模式"。
