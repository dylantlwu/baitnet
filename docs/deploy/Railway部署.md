# BaitNet 上线：Railway 部署步骤（给 Dylan）


> **现行部署（2026-11-10，产品用 Railway CLI 建好）**
> - 项目 `baitnet` / 服务 `baitnet` / 环境 `production`，区域 Southeast Asia（Singapore），Volume `baitnet-volume` 挂 `/data`
> - 网址：https://baitnet-production.up.railway.app （来源：GitHub `dylantlwu/baitnet` 的 main 分支，push 即自动部署）
> - 已填：PORT、BAITNET_AUTH=on、BAITNET_MODE=live、BAITNET_REVIEW=manual、BAITNET_LLM_DAILY_LIMIT=200、NEAR_NETWORK/NEAR_RPC_URL、BAITNET_PUBLIC_URL/CORS_ORIGINS、两个随机密钥（副本在本机 `.env.railway`，已被 git 忽略，请移进密码管理器）
> - **Dylan 还要填**：`NEARAI_API_KEY`（用新 key）；测试网部署后填 4.3 节的账户和私钥；在 Usage 里设月度上限
> - `railway.json` 属于 Railway 的 "Config as Code"，官方说 2026-12-01 前继续有效；评审期结束后再迁移到 `.railway/railway.ts`

> 现行方案：**一个 Railway 项目 + 一个服务 + 一个 Volume + 一个域名**。旧的香港 VPS 方案见 [部署说明.md](部署说明.md)，保留备用。
> 代码侧已准备好：`Dockerfile`、`.dockerignore`、`railway.json`、`deploy/docker-entrypoint.sh`（容器里的 `baitnet` 命令）、`scripts/backup-data.ts`。
> 更新：2026-11-10（运维 agent）

---

## 0. 先知道这几件事

- **Railway 怎么跑这个项目**：Railway 从 GitHub 仓库 `dylantlwu/baitnet` 拉代码，按根目录的 `Dockerfile` 构建镜像（安装依赖 → 构建网页 → 用 tsx 直接运行 server），网页和接口都在**同一个端口**上。
- **配置都在根目录的 `railway.json` 里**，不用在网页上手动设：单副本、健康检查路径 `/health`、崩溃自动重启、必须挂载 `/data` 的 Volume（没挂的话部署会直接失败，不会悄悄把数据写到临时磁盘里）。
- **数据都在 Volume `/data` 里**：sqlite 数据库、证据文件、竞技场会话、评测结果都在这里。每次重新部署时，镜像会整个换成新的，但 Volume 里的数据会保留。
- **只能单副本**：sqlite 不能多个实例同时写。每次部署会先停掉旧容器再启动新容器，中间会有**十几秒到一分钟**打不开，属于正常现象。
- **镜像里不包含任何 `.env` 或 `data/`**：`.dockerignore` 已经排除了这些文件。所有密钥都只放在 Railway 的 Variables 里。

---

## 1. 创建项目并连接 GitHub

1. 打开 <https://railway.com>，登录（可以直接用 GitHub 账号）。
2. 选择套餐：**Hobby** 就够用（费用见第 11 节）。
3. **New Project → Deploy from GitHub repo**，选择 `dylantlwu/baitnet`。第一次使用时会跳到 GitHub，要求给 Railway 授权访问这个仓库，**只勾选这一个仓库**即可。
4. Railway 会自动识别 `railway.json`，用 Dockerfile 开始构建。**第一次部署会失败**，因为还没有挂 Volume，这是 `requiredMountPath` 在起作用，属于正常现象。先往下做。
5. 服务的 **Settings → Source**：确认 Branch 是 `main`。以后每次 push 到 main，Railway 都会自动重新部署（`railway.json` 里的 `watchPatterns` 限定了只有改动代码时才会触发，单纯改 docs 不会触发）。

## 2. 选区域（要在挂 Volume 之前做）

服务 **Settings → Deploy → Region**，建议选 **Southeast Asia (Singapore)**。

- 新加坡离国内和东南亚都比较近，延迟最低。
- **Volume 和服务在同一个区域**。先选好区域再加 Volume，之后改区域需要迁移 Volume，迁移期间服务会停。
- **大陆访问说明**：Railway 默认分配的 `*.up.railway.app` 域名在大陆**可能不稳定**，时好时坏，偶尔也会被整体干扰。比赛演示和给同事使用，建议绑定自己的域名（见第 6 节）。微信内置浏览器对未备案域名的限制跟以前一样，参考 [部署说明.md 第 7 节](部署说明.md)。

## 3. 添加 Volume（挂到 /data）

1. 在项目画布上右键点击服务（或者按 `⌘K`）→ **Attach Volume / New Volume**，选这个服务。
2. **Mount path 填 `/data`**（必须是这个路径，跟 `railway.json` 的 `requiredMountPath` 和镜像里的 `BAITNET_DATA_DIR=/data` 对应）。
3. 大小：初始默认值就够用（数据量很小，以 MB 计）。以后不够了可以在 Volume 设置里扩容。
4. Volume 的 **Backups** 标签：打开自动备份（建议选 Daily）。详见第 8 节。

## 4. 填环境变量

服务 → **Variables**。最省事的方法是点 **Raw Editor**，把下面整段粘进去，再逐个填值。完整说明在 `deploy/env.production.example`，**但下面这些跟 VPS 不同的地方以本文为准**。

### 4.1 不要填（镜像里已经设好，填了反而容易出错）

| 变量 | 镜像里的值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | |
| `HOST` | `0.0.0.0` | Railway 必须从外部访问这个端口（VPS 上用的 `127.0.0.1` 在这里**不能用**） |
| `BAITNET_DATA_DIR` | `/data` | 就是 Volume 的挂载点 |
| `BAITNET_WEB_DIST` | `/app/apps/web/dist` | 网页构建产物 |

### 4.2 必填

```
PORT=8080
BAITNET_AUTH=on
BAITNET_PUBLIC_URL=https://（第 5 步生成域名后回来填）
BAITNET_CORS_ORIGINS=https://（同上，跟 PUBLIC_URL 一样）
BAITNET_SESSION_SECRET=
BAITNET_EVIDENCE_KEY=
BAITNET_LLM_DAILY_LIMIT=200
BAITNET_MODE=live
BAITNET_REVIEW=manual
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEARAI_API_KEY=
```

- `PORT=8080`：显式固定端口，第 5 步生成域名时填的端口也是 8080，两边对得上。
- **两个随机密钥**：在你自己的 Mac 终端里执行两次下面的命令，每次的输出分别填入 `BAITNET_SESSION_SECRET` 和 `BAITNET_EVIDENCE_KEY`：
  ```bash
  openssl rand -hex 32
  ```
  **`BAITNET_EVIDENCE_KEY` 丢了，加密的证据就再也读不出来了。** 填完以后把它（以及整份变量）存进密码管理器。Railway 的备份**只备份 Volume，不包含变量**。
- `NEARAI_API_KEY`：用一把**跟你笔记本上不同的 key**，这样两把 key 可以分别吊销。同时在 NEAR AI 控制台设置月度预算上限。

### 4.3 测试网账户（要上链就填；不填也能启动，只是改用内存登记表、警报不上链）

```
REGISTRY_CONTRACT_ID=
VAULT_CONTRACT_ID=
OWNER_ACCOUNT_ID=
OWNER_PRIVATE_KEY=
REPORTER_ACCOUNT_ID=
REPORTER_PRIVATE_KEY=
AGENT_ACCOUNT_ID=
AGENT_PRIVATE_KEY=
RESPONDER1_ACCOUNT_ID=
RESPONDER1_PRIVATE_KEY=
RESPONDER1_NAME=DemoWallet
RESPONDER2_ACCOUNT_ID=
RESPONDER2_PRIVATE_KEY=
RESPONDER2_NAME=DemoExchange
```

值从后端 A 的 `.env.testnet` 复制。每次容器启动时，入口脚本会用这些变量重新生成 `/data/runtime.json`（权限 600）。如果缺少变量，日志里会出现 `write-runtime: Railway Variables 缺少 …`，服务照样启动，`/health` 里的 `warning` 会说明当前用的是内存登记表。

**私钥类的变量**（`*_PRIVATE_KEY`、`NEARAI_API_KEY`、两个 secret）建议在 Variables 里点变量右侧的 **⋮ → Seal**。封存（seal）之后，网页和 CLI 都看不到这些值，但容器里照常能用。注意：封存以后在 Railway 上就再也看不到值了，所以一定要先存进密码管理器。

### 4.4 可选

```
NEARAI_MODEL=
NEARAI_CLAUDE_MODEL=
ANTHROPIC_API_KEY=
BAITNET_LLM=
LIVE_INTENTS=0
INTENTS_EXPLORER_JWT=
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
```

留空就表示用默认值（说明见 `deploy/env.production.example`）。只要填了 `TELEGRAM_BOT_TOKEN`，服务启动时就会连接 Telegram 机器人。

填完以后点 **Deploy**（或者页面顶部的 "Apply changes"）。

## 5. 生成域名，再回填 BAITNET_PUBLIC_URL

1. 服务 **Settings → Networking → Public Networking → Generate Domain**，端口填 **8080**，会得到类似 `baitnet-production-xxxx.up.railway.app` 的域名。
2. 回到 **Variables**，把 `BAITNET_PUBLIC_URL` 和 `BAITNET_CORS_ORIGINS` 都改成 `https://<这个域名>`（不要带结尾的 `/`）。保存后会自动重新部署。
   - `BAITNET_PUBLIC_URL` 决定邀请链接和二维码里的地址。**以后绑了自定义域名，也要回来改这两个变量。**
3. 等部署状态变成 **Active**（健康检查 `/health` 通过才会切换），然后用浏览器打开 `https://<域名>`，应该能看到 BaitNet 控制台和登录页。
4. 自检（在你的 Mac 上执行）：
   ```bash
   curl -s https://<域名>/health          # {"ok":true,"mode":...,"network":"testnet",...}
   curl -sI https://<域名>/events | head  # content-type: text/event-stream
   ```
   如果 `/health` 里的 `network` 是 `memory`，说明测试网变量没填全，回第 4.3 节检查。

## 6. 绑定自定义域名（推荐，特别是给大陆同事使用）

1. 服务 **Settings → Networking → Custom Domain**，填你的域名（例如 `baitnet.example.com`），端口填 8080。
2. Railway 会给出一条 **CNAME 记录**（有时还会附带一条用于验证的 TXT 记录）。到你的域名服务商（Cloudflare、阿里云、Namecheap 等）的 DNS 设置里照着添加。
   - 用 Cloudflare 的话，**先把小云朵设为灰色（DNS only）**，等 Railway 显示证书签发成功以后再考虑开代理。开代理时 SSL 模式要选 **Full**。
3. 几分钟后 Railway 会显示绿色勾，证书由 Railway 自动签发和续期。
4. **回到 Variables，把 `BAITNET_PUBLIC_URL` 和 `BAITNET_CORS_ORIGINS` 改成新域名**。改之前发出去的邀请链接里还是旧域名，但旧域名仍然可以用，邀请码本身不受影响。
5. 自定义域名**不能保证**在大陆一定访问稳定（流量还是走 Railway 的海外入口），但比共享的 `*.up.railway.app` 好很多。演示前请用大陆网络实际测一遍。

## 7. 生成第一个 reviewer 邀请码

只有第一个 reviewer 需要在命令行生成，之后 reviewer 可以在网页的管理页里给其他人发邀请。

1. 在你的 Mac 上安装 Railway CLI 并登录（只需要做一次）：
   ```bash
   brew install railway      # 或者：npm i -g @railway/cli
   railway login
   cd ~/BaiNet && railway link   # 选这个项目、production 环境、baitnet 服务
   ```
2. 在**正在运行的容器里**执行（会写入 Volume 里的 `/data/auth.sqlite`）：
   ```bash
   railway ssh -- baitnet invite --name Dylan --role reviewer
   ```
   如果这种一行命令的写法不支持，就先执行 `railway ssh` 进入容器，再输入 `baitnet invite --name Dylan --role reviewer`，最后用 `exit` 退出。
3. 终端会打印**邀请码（只显示这一次）**和一点即登链接，链接地址就是 `BAITNET_PUBLIC_URL`。用这个链接登录即可。
4. 其他常用命令：
   ```bash
   railway ssh -- baitnet invite --list                 # 列出所有邀请（邀请码已打码）
   railway ssh -- baitnet invite --revoke <邀请码或ID>   # 吊销，对方的登录立即失效
   railway ssh -- baitnet invite --name 张三 --role expert
   ```

> 为什么不用 `railway run`：`railway run` 是在**你自己的电脑上**带着 Railway 的变量运行命令，写的是你本机的 `data/`，**不会**写到线上的 Volume。线上操作要用 `railway ssh`。
> `baitnet` 命令是镜像里的入口脚本（`deploy/docker-entrypoint.sh`）。`railway ssh` 默认以 root 身份进入容器，脚本会自动切换成应用用户 `node` 再执行，所以生成的文件归属正确，不会出现服务读不了文件的情况。

## 8. 备份和恢复

### 8.1 自动备份（主要依靠这个）

Volume → **Backups**：打开定时备份（Daily / Weekly），也可以随时点 **Backup now** 手动备一次。**重大操作（改数据结构的版本上线、恢复数据）之前，先手动备一次。**
恢复：在 Backups 列表里选一个备份 → **Restore**。Railway 会把整个 Volume 回退到那个时间点，然后重新部署（以 Railway 网页上的实际提示为准）。

### 8.2 手动导出一份到自己电脑（建议每周一次，或者比赛前后各一次）

```bash
# 1) 在容器里生成一个一致性快照：所有 *.sqlite 都用 VACUUM INTO 复制并做完整性检查，
#    其余文件（evidence/、arena/、eval/、*.json 等）原样打包。不包含 runtime.json（里面有私钥）。
railway ssh -- baitnet backup
#    → backup ok: /data/backups/manual/baitnet-20261110T....tar.gz (2 sqlite, N other entries, x MB)
#    （Volume 里只保留最近 5 份）

# 2) 下载到本机：以 base64 文本的形式传输，再在本机还原（把文件名换成上一步输出的那个）
F=/data/backups/manual/baitnet-20261110T....tar.gz
railway ssh -- base64 -w0 "$F" > baitnet-backup.b64
tr -d '\r\n' < baitnet-backup.b64 | base64 -d > baitnet-backup.tar.gz
tar -tzf baitnet-backup.tar.gz     # 能列出 auth.sqlite、training.sqlite 等文件，就说明下载成功
rm baitnet-backup.b64
```

下载下来的文件里有用户数据（证据是加密的，但聊天记录、邀请、审计日志是明文的），请放在加密磁盘或者密码管理器的附件里。仓库根目录的 `backups/` 已经在 `.gitignore` 里了，可以放在那里。

> 如果第 2 步得到的文件 `tar -tzf` 报错，原因是终端在传输中混入了多余的字符。这时可以先执行 `railway ssh`，在容器里运行 `sha256sum "$F"`，再在本机运行 `shasum -a 256 baitnet-backup.tar.gz` 对比。如果仍然对不上，就改用 8.1 的 Volume 备份。

### 8.3 用 Volume 里的手动快照恢复

```bash
railway ssh -- ls -l /data/backups/manual/              # 看看有哪些快照
railway ssh -- baitnet restore /data/backups/manual/baitnet-20261110T....tar.gz
#    → staged: auth.sqlite evidence ... training.sqlite
```

然后在 Railway 网页上：服务 → **Deployments** → 当前部署右边的 **⋮ → Restart**。容器启动时，**在 server 打开数据库之前**就会把快照换进去，原来的文件会移到 `/data/backups/pre-restore-<时间>/`，**不会被删除**。日志里能看到 `restore applied (...)`。

### 8.4 导出训练数据（给以后微调模型用）

专家的「好」评分、审核通过的改写、话术库，可以导出成两份 JSONL：
- `sft.jsonl`：示范样本，格式是 OpenAI 的 messages；
- `preference.jsonl`：好回复和坏回复配对（chosen / rejected），用于 DPO。

导出时，姓名、电话、地址等个人资料会被换成 `[NAME_1]` 这类占位符。只有诱饵一方的回复会作为学习目标，骗子的话只当上下文。

```bash
# 1) 在容器里导出并打包（Volume 里只保留最近 5 份）
railway ssh -- baitnet export
#    → [training:export] N SFT sample(s) … / M preference pair(s) …
#    → export ok: /data/training-export/baitnet-training-20261111T....tar.gz (x KB)

# 2) 下载到本机，方法和 8.2 节一样（把文件名换成上一步输出的那个）
F=/data/training-export/baitnet-training-20261111T....tar.gz
railway ssh -- base64 -w0 "$F" > training.b64
tr -d '\r\n' < training.b64 | base64 -d > baitnet-training.tar.gz
tar -tzf baitnet-training.tar.gz   # 能看到 sft.jsonl 和 preference.jsonl，就说明下载成功
rm training.b64
```

导出的内容虽然已经去掉了个人资料，但仍然是内部对话素材，**不要提交到 Git 仓库，也不要公开**。可以放在仓库根目录的 `backups/` 里，那个目录已经被 Git 忽略。

## 9. 回滚代码版本

服务 → **Deployments**，找到上一个正常的部署 → **⋮ → Redeploy**（有的界面叫 Rollback）。也可以在 GitHub 上 revert 这次提交再 push。

- 回滚只会切换**代码/镜像**，**不会**回滚 Volume 里的数据。如果新版本已经改动了数据结构，回滚前先按 8.1 节恢复数据，或者先确认旧版本能读新数据。
- 部署失败（构建出错或健康检查不通过）时，Railway **不会**切换流量，旧版本会继续运行，不需要手动回滚。

## 10. 日常运维

| 要做的事 | 在哪里 |
|---|---|
| 看日志 | 服务 → Deployments → 点开当前部署 → **Deploy Logs**；或者在终端执行 `railway logs` |
| 改配置 | Variables 里改，保存后会自动重新部署 |
| 发版本 | push 到 `main`，Railway 会自动构建和部署（大约 2~4 分钟） |
| 重启 | Deployments → ⋮ → Restart |
| 看资源用量和费用 | 项目 → **Metrics**；账户 → **Usage** |
| 导出训练数据 | `railway ssh -- baitnet export`（见 8.4） |
| 进容器排查问题 | `railway ssh`（用 `ls /data`、`baitnet invite --list` 等） |

- Railway 的健康检查**只在部署时执行**，不会持续监控。需要监控的话，可以用 UptimeRobot 之类的免费服务每 5 分钟访问一次 `https://<域名>/health`。
- SSE（`/events`）走 Railway 的代理，不会被缓冲（server 已经设置了 `x-accel-buffering: no`，并且每 15 秒发一次心跳）。Railway 代理对单个长连接可能有时长上限，到上限后浏览器的 EventSource 会自动重连，页面不需要额外处理。
- 在 Railway 的账户 **Usage → Usage Limits** 里设一个**硬性月度上限**，防止意外超支。

## 11. 费用大致范围（以官网 <https://railway.com/pricing> 为准）

- **Hobby 套餐**：每月 5 美元订阅费，包含 5 美元的资源用量，超出部分按量计费。
- 按量计费的几项：内存（约 10 美元/GB·月）、CPU（约 20 美元/vCPU·月，按实际使用量计算）、Volume（约 0.15 美元/GB·月）、出口流量（约 0.05 美元/GB）。
- 这个项目：Node 进程常驻内存大约 200~400 MB，CPU 平时接近空闲，数据量以 MB 计。**估计每月 5~10 美元**，大部分月份不会超出套餐自带的额度太多。
- **大模型费用另算**：NEAR AI / Anthropic 按调用次数单独计费，由 `BAITNET_LLM_DAILY_LIMIT` 和各自控制台里的预算上限来控制。

---

## 附：代码侧做了什么（给以后维护的人）

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 多阶段构建。build 阶段：`pnpm install --frozen-lockfile` → `pnpm --filter @baitnet/web build`。runtime 阶段：`node:22.22.2-bookworm-slim` + gosu，`ENTRYPOINT baitnet`、`CMD start` |
| `.dockerignore` | 排除 `.git`、`node_modules`、`dist`、`.env*`（保留 `.env.example`）、`data/`、`backups/`、`.cache/`、`contracts/target`、`*.sqlite`、`runtime.json`、`*.pem`、`*.key` 等 |
| `railway.json` | DOCKERFILE 构建器、`numReplicas: 1`、`requiredMountPath: /data`、`healthcheckPath: /health`、`ON_FAILURE` 重启、不休眠 |
| `deploy/docker-entrypoint.sh` | 以 root 身份启动，修正 `/data` 的属主后降权到 `node` 用户。`start` 依次执行：应用待恢复的快照 → `scripts/write-runtime.ts`（失败不阻止启动）→ `apps/server` 下的 `tsx src/main.ts`。另外提供 `invite`、`backup`、`restore` 三个子命令 |
| `scripts/backup-data.ts` | 用 `node:sqlite` 执行 `VACUUM INTO` 并做 quick_check，再用 tar 打包成单个文件。不依赖 sqlite3 命令行工具 |
| `apps/server/src/host.ts` | 检测到 `RAILWAY_ENVIRONMENT` 时监听 `0.0.0.0`。`HOST` 变量优先级最高；本地开发和 VPS 上的行为不变 |

本地验证方法（没有 Docker 时的等价步骤）：按 `.dockerignore` 把仓库复制到临时目录 → `pnpm install --frozen-lockfile` → 构建网页 → 用 `NODE_ENV=production RAILWAY_ENVIRONMENT=production PORT=8099 BAITNET_DATA_DIR=<临时目录>` 执行 `deploy/docker-entrypoint.sh start`（可以用 `BAITNET_APP_DIR` 指向那个临时目录）。
