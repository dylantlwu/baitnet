# BaitNet 合约

两个 NEAR 合约（Rust，near-sdk 5.30.1）：

| 合约 | 目录 | 预编译 wasm |
|---|---|---|
| AlertRegistry（M3） | `registry/` | `registry/res/registry.wasm` |
| Vault（D12） | `vault/` | `vault/res/vault.wasm` |

预编译 wasm 已提交，`pnpm demo` 直接部署它们，**不需要装 Rust**。

---

## 1. AlertRegistry

### 1.1 方法

| 方法 | 谁能调用 | 说明 |
|---|---|---|
| `new(owner)` | 合约账户本身（`#[private]`，部署时的 init call） | 初始化 |
| `add_reporter(id) -> bool` / `remove_reporter(id) -> bool` | owner | 报告者白名单。返回是否有变化 |
| `report(address, chain, evidence_hash, level, category) -> u64` | 白名单报告者 | 新建警报并返回 id。若同一 (chain, address) 的**最新**警报是 `Active`，则不新建，而是把 `evidence_hash` 追加到该警报（重复 hash 不重复存），若新 level 更严重则升级（L1 > L2 > L3，不会降级），返回原 id |
| `set_status(alert_id, status, reason_hash?)` | owner 或该警报的原报告者 | `Active` / `Disputed` / `Revoked`。`reason_hash` 可为 `null`。不能设成相同状态；旧警报已被同地址更新的警报取代时不能再设回 `Active` |
| `register_responder(name)` | 任何人，**需附 storage 押金**（约 0.002 NEAR，附 0.01 NEAR 即可，多余自动退回） | 自愿登记为公开回应方；再次调用 = 改名 |
| `ack(alert_id, outcome)` | 已登记的回应方 | `Seen` / `Blocked` / `Reported`。每个 (警报, 回应方) 只存一条，后一次覆盖前一次 |
| `check(chain, address) -> Option<AlertView>` | view | 守卫核心查询（规则见 1.3） |
| `list_alerts(from_index?, limit?) -> AlertView[]` | view | 按 id 升序；默认 50，最大 100 |
| `get_alert(id) -> Option<AlertView>` | view | |
| `get_acks(alert_id) -> AckView[]` | view | |
| `stats() -> Stats` | view | `{ total_alerts, active, disputed, revoked, reporters, responders, acks }` |
| `list_responders(from_index?, limit?)` / `get_responder(account_id)` | view | 额外提供，给 Dashboard 响应记录表用 |
| `get_owner()` / `is_reporter(account_id)` / `list_reporters()` | view | 额外提供 |

- **警报 id 从 0 开始**（= 内部 Vector 下标），`list_alerts` 的 `from_index` 就是 id，可直接当增量同步游标：下一次 `from_index = 上次最大 id + 1`。注意：追加证据 / 改状态不会产生新 id，增量同步还需要定期刷新已有警报（或监听事件）。
- 枚举严格：`chain` 只接受 `near|evm|tron|btc`，`level` 只接受 `L1|L2|L3`，`status`、`outcome` 同理；其他值在参数反序列化阶段就失败。
- `evidence_hash` / `reason_hash`：64 位十六进制 sha256，可带 `0x` 前缀，存成小写无前缀。
- `category`、`name`：非空，≤ 64 字节，不含控制字符。

### 1.2 地址规范化（存储和 `check` 用同一套规则）

| chain | 规则 |
|---|---|
| `evm` | 必须是 `0x` + 40 位十六进制；**转小写**存储 |
| `near` | 必须是合法 NEAR 账户名；转小写 |
| `btc` | 只允许字母数字；bech32（`bc1`/`tb1`/`bcrt1` 开头）转小写，base58 保持原样 |
| `tron` | 只允许字母数字；base58 保持原样（大小写敏感） |

前后空白会被去掉，长度 ≤ 128。`report` 遇到非法地址直接失败；`check` 遇到非法地址返回 `null`。

### 1.3 `check` 的返回规则（L3 的处理）

`check` 只看该 (chain, address) 的**最新**警报：

| 最新警报 | `check` 返回 |
|---|---|
| 不存在 | `null` |
| `Revoked` | `null` |
| level = **L3**（任何状态） | **`null`** —— L3 只存不推（对应 M2「L3 不推送」）；可以用 `get_alert` / `list_alerts` 看到 |
| `Active` 或 `Disputed`，level L1/L2 | `AlertView` |

所以守卫拿到非空结果时只需按 M4 信号表判断：`Active + L1` → block；`L2` 或 `Disputed` → warn。L3 警报被后续 L1/L2 报告追加后会升级，随即对 `check` 可见。

### 1.4 JSON 视图 ↔ `packages/shared` 类型

合约 JSON 用 snake_case；时间戳是**纳秒**，序列化为十进制字符串（u64 超出 JS 安全整数）。

`AlertView`

| 合约字段 | 类型 | TS 字段 | 说明 |
|---|---|---|---|
| `id` | number | `id` | |
| `chain` | `"near"\|"evm"\|"tron"\|"btc"` | `chain` | |
| `address` | string | `address` | 已规范化 |
| `level` | `"L1"\|"L2"\|"L3"` | `level` | |
| `category` | string | `category` | |
| `evidence_hash` | string | `evidenceHash` | 第一次报告的 hash |
| `evidence_hashes` | string[] | —（建议新增 `evidenceHashes?`） | 全部 hash，含追加的；`[0] == evidence_hash` |
| `status` | `"Active"\|"Disputed"\|"Revoked"` | `status` | |
| `reporter` | string | `reporter` | 原报告者 |
| `created_at` | string（ns） | `createdAt` | 转 ISO：`new Date(Number(BigInt(v) / 1_000_000n)).toISOString()` |
| `updated_at` | string（ns） | —（可选） | 追加证据 / 改状态时更新 |
| `status_reason_hash` | string \| null | —（可选） | 最近一次 `set_status` 的 reason_hash |
| — | | `txHash?` | 合约拿不到，由后端从交易结果 / 事件索引补上 |

`AckView` → `Ack`：`alert_id`→`alertId`，`responder`，`outcome`，`at`（ns 字符串）→`at`（ISO）。
`ResponderView` → `Responder`：`account_id`→`accountId`，`name`，`registered_at`（ns）→`registeredAt`（ISO）。

---

## 2. Vault

owner 把 NEAR 存进 Vault；只有指定的 agent 账户能调用 `pay(to, amount)` 把钱转出，而且每笔都要先过 registry。

### 2.1 方法

| 方法 | 谁能调用 | 说明 |
|---|---|---|
| `new(owner, agent, registry, per_tx_limit, daily_limit)` | 合约账户本身（`#[private]`） | 金额都是 yoctoNEAR 字符串；`agent ≠ owner`；`0 < per_tx_limit ≤ daily_limit` |
| `deposit()` | 任何人（payable） | 充值 |
| `pay(to, amount) -> bool` | **仅 agent**；非 payable | 见 2.2。建议附 100 TGas |
| `withdraw(amount?)` | owner | 不传 amount = 取出全部可用余额 |
| `set_agent(agent)` / `set_limits(per_tx_limit, daily_limit)` / `set_registry(registry)` | owner | |
| `get_config()` | view | `{ owner, agent, registry, per_tx_limit, daily_limit, day, spent_today, pending, available }` |
| `on_check` / `on_transfer` / `fail_payment` | 合约自己（`#[private]` 回调） | 内部使用 |

### 2.2 `pay` 流程

```
agent ──pay(to, amount)──▶ vault
   检查：调用者 == agent；0 < amount ≤ per_tx_limit；今日已用+在途 + amount ≤ daily_limit；余额足够
   预留额度（防止并发 pay 突破上限），发 pay_requested
   └─▶ registry.check("near", to) ──▶ vault.on_check
          ├─ Active 且 L1/L2      → 释放额度，发 pay_blocked{reason:"flagged"}，交易最终 Failure（PAY_BLOCKED）
          ├─ registry 调用失败     → 同上，reason:"registry_unavailable"（fail-closed）
          └─ null / Disputed      → transfer(to, amount) ──▶ vault.on_transfer
                                       ├─ 成功 → 发 paid，返回 true
                                       └─ 失败（如收款账户不存在）→ 释放额度，发 pay_failed，交易 Failure
```

- 被拦下时**整笔交易的最终状态是 Failure**（near-api-js 会抛错，错误信息含 `PAY_BLOCKED`），但 `pay_blocked` 事件写在 `on_check` 回调的 receipt 里，不会被回滚，可以在交易的 receipts 日志里看到。实现方法：回调先发事件，再返回一个调用 `fail_payment` 的 promise，由它 panic。
- 链上只拦 **Active 的 L1/L2**；`Disputed` 放行（`paid` 事件里带 `registry_status: "Disputed"`），由链下守卫负责 warn / 问人。
- 每日上限按 UTC 日（`block_timestamp / 86400s`）计，换日自动清零。被拦或转账失败的金额会退回额度。
- Vault 只检查 `near` 链地址（`to` 是 NEAR 账户）。

### 2.3 agent 的 function-call key

agent 账户上给付款 agent 用的 key 应该是：

```
near account add-key <agent>.testnet grant-function-call-access \
  --allowance '0.5 NEAR' --contract-account-id <vault>.testnet --function-names pay \
  use-manually-provided-public-key ed25519:... network-config testnet sign-with-... send
```

这把 key **能做的**：以 agent 身份调用 `<vault>.pay`，并用 allowance 支付 gas。

这把 key **不能做的**（集成测试 `function_call_key_is_scoped_to_vault_pay` 逐项验证）：

- **不能直接转 NEAR**：function-call key 不能签 Transfer action，也不能给调用附带 deposit（所以 `pay` 故意不是 payable）。agent 账户自己的余额它动不了。
- **不能加 / 删 key、不能部署合约、不能删账户**：这些都需要 full-access key。
- **不能调用别的合约或 Vault 的其他方法**（`withdraw`、`set_limits`、`set_registry`、registry 的写方法……）。
- 即使 key 被 prompt 注入的 agent 滥用，钱也只能经 `pay` 流出，并且受 registry 拦截 + 单笔上限 + 每日上限约束。

**限制**：allowance 是这把 key 能花的 gas 总额，**用完后这把 key 就锁住了**（所有交易被拒），只能用 full-access key 删掉重加。每笔交易会从 allowance 中按**预付 gas**（不是实际消耗）扣费，未用完的 gas 退回的是账户余额而不是 allowance：`pay` 预付 100 TGas，按 0.1 Gwei 的 gas 价格约扣 0.01 NEAR，0.5 NEAR 的 allowance 约够 50 次。demo 前用 `near account list-keys` 确认余量。

---

## 3. 事件（NEP-297）

所有写操作都打一条日志：

```
EVENT_JSON:{"standard":"baitnet","version":"1.0.0","event":"<name>","data":[{...}]}
```

`data` 恒为单元素数组。金额是 yoctoNEAR 字符串，`at` 是 ns 字符串。

| 合约 | event | data 字段 |
|---|---|---|
| registry | `add_reporter` / `remove_reporter` | `account_id, by` |
| registry | `report` | `alert_id, chain, address, level, category, evidence_hash, reporter, appended`（`appended:true` = 追加到已有警报；此时 `level` 是升级后的等级，`reporter` 是这次的调用者） |
| registry | `set_status` | `alert_id, chain, address, old_status, status, reason_hash, by` |
| registry | `register_responder` | `account_id, name, new` |
| registry | `ack` | `alert_id, responder, outcome, at` |
| vault | `deposit` | `from, amount` |
| vault | `withdraw` | `to, amount` |
| vault | `pay_requested` | `to, amount, agent` |
| vault | `pay_blocked` | `to, amount, reason("flagged"\|"registry_unavailable"), alert({alert_id, level, status} 或 null), registry` |
| vault | `paid` | `to, amount, agent, registry_status(null 或 "Disputed")` |
| vault | `pay_failed` | `to, amount, reason("transfer_failed"\|"insufficient_balance")` |
| vault | `config_updated` | `agent, registry, per_tx_limit, daily_limit` |

---

## 4. 构建与测试

前提：Rust（含 `wasm32-unknown-unknown` target）、`cargo-near` 0.23。

```bash
source ~/.cargo/env
cd contracts

# 单元测试（registry 29 个 + vault 22 个）
cargo test -p baitnet-registry -p baitnet-vault

# 重新编译 wasm 并覆盖 */res/*.wasm
./build.sh            # 等价于在 registry/ 和 vault/ 里各跑 cargo near build non-reproducible-wasm 再复制

# near-workspaces 集成测试（5 个；用的是 res/ 里已提交的 wasm，改代码后先 ./build.sh）
# 第一次运行会下载 near-sandbox 二进制
cargo test -p baitnet-integration-tests
```

集成测试覆盖：部署两个合约 → 报告地址 → `vault.pay` 到该地址被拒（交易 Failure + `pay_blocked`，余额不变，额度退回）→ 到干净地址成功 → `set_status(Revoked)` 后 pay 恢复；Active L2 拦截、Disputed 放行；证据追加与 EVM 小写；非法 level / 非报告者失败；ack 权限（未登记失败、无押金登记失败、登记后成功、非法 outcome 失败）；Vault 权限与单笔 / 每日上限；function-call key 的权限范围。

### 部署（参考，未执行）

```bash
near contract deploy <registry>.testnet use-file registry/res/registry.wasm \
  with-init-call new json-args '{"owner":"<owner>.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

near contract deploy <vault>.testnet use-file vault/res/vault.wasm \
  with-init-call new json-args '{"owner":"<owner>.testnet","agent":"<agent>.testnet","registry":"<registry>.testnet","per_tx_limit":"1000000000000000000000000","daily_limit":"5000000000000000000000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

Registry 的 storage 由合约账户余额承担（报告者是白名单，`register_responder` 由调用者付押金），部署账户留 ≥ 5 NEAR 即可。

---

## 5. 测试网部署

> 状态：**尚未部署**。脚本已就绪，需要 Dylan 本人运行（它会通过官方水龙头创建账户并处理私钥）。部署完成后把下表的 `<owner>` 换成实际账户名。

| 角色 | 账户 | 浏览器 |
|---|---|---|
| owner | `<owner>`（如 `baitnet-xxxx.testnet`） | `https://testnet.nearblocks.io/address/<owner>` |
| AlertRegistry | `registry.<owner>` | `https://testnet.nearblocks.io/address/registry.<owner>` |
| Vault | `vault.<owner>` | `https://testnet.nearblocks.io/address/vault.<owner>` |
| reporter | `reporter.<owner>` | |
| agent | `agent.<owner>`（只有一把限 `vault.<owner>` / `pay` 的 function-call key，allowance 0.25 NEAR） | |
| responder1 / responder2 | `responder1.<owner>`（DemoWallet）/ `responder2.<owner>`（DemoExchange） | |

Vault 参数：单笔上限 0.2 NEAR，每日上限 0.5 NEAR，初始存入 1 NEAR。

### 一键部署 + 冒烟测试

```bash
bash contracts/scripts/deploy-testnet.sh            # 或传入指定 owner：... baitnet-1234.testnet
```

脚本依次：水龙头创建 owner → 从 owner 出资建 6 个子账户 → 部署并初始化两个合约 → `add_reporter`、Vault 存款、两个回应方登记 → 给 agent 加 function-call key 并删除其 full-access key → 冒烟测试（report → check 命中 → pay 到被标记地址失败且含 `PAY_BLOCKED` → pay 到 responder1 成功 → `set_status(Revoked)` 后 check 为 null）→ 写 `.env.testnet`（已被 `.gitignore` 的 `.env.*` 忽略）。

私钥只在 `~/.near-credentials/testnet/`（legacy keychain）和 `.env.testnet` 里，**不要提交**。

### 重新部署代码（保留状态）

```bash
./build.sh
near contract deploy registry.<owner> use-file registry/res/registry.wasm without-init-call network-config testnet sign-with-legacy-keychain send
near contract deploy vault.<owner>    use-file vault/res/vault.wasm    without-init-call network-config testnet sign-with-legacy-keychain send
```

存储结构变了（字段增删）就不能原地升级，需要换新的子账户重新跑脚本。agent 的 allowance 用完后这把 key 就锁住了，而 agent 已没有 full-access key，无法自救：做法是由 owner 新建一个 agent 子账户（重复脚本里 agent 那几步），再由 owner 调用 `vault.set_agent` 换过去。
