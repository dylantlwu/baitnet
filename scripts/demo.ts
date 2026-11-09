/**
 * BaitNet one-command demo (module M9).
 *
 *   pnpm demo                 offline (default): local NEAR sandbox + replay LLM + fixtures, no keys
 *   pnpm demo testnet         use contracts/accounts already deployed on testnet (from .env)
 *   pnpm demo live            testnet (or sandbox if not configured) + real NEAR AI / Claude / Intents APIs
 *   pnpm demo --ci            run the whole flow, assert key outputs, exit 0/1 (no long-running services)
 *   pnpm demo:export          offline flow + export apps/web/public/snapshot.json + build web (static hosting)
 *
 * Other flags: --no-web (start backend only), --skip-flow (only chain setup + services),
 *              --full (with --ci: run the full ①–⑥ storyline instead of the P0 smoke flow),
 *              --fresh (back up, then wipe ALL of data/ incl. training DB; keeps evidence/.key + backups/), --help
 *
 * data/: each start backs up data/training.sqlite to data/backups/ (newest 10 kept) and clears only
 * chain-bound state (see scripts/lib/data.ts). Training data, arena sessions and evidence are kept.
 *
 * Last line of defence: if the sandbox binary cannot be downloaded/started, the demo falls back
 * to the backend's in-memory registry (BAITNET_REGISTRY=memory) and says so loudly.
 * `--ci` never falls back (exit 1) unless BAITNET_REQUIRE_CHAIN=0; set BAITNET_REQUIRE_CHAIN=1 to forbid it
 * everywhere. BAITNET_REGISTRY=memory skips the chain on purpose.
 *
 * Contract with the backend: this script writes data/runtime.json (docs/01_功能模块.md §4),
 * then runs `pnpm --filter @baitnet/agent run demo-flow`, then starts
 * `@baitnet/server start` (port 8787) and `@baitnet/web dev` (port 5173).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SANDBOX_ROOT, Chain, call, createFullAccount, createFunctionCallOnlyAccount, deployAndInit, sandboxRootKey, startSandbox } from "./lib/near.ts";
import type { KeyedAccount } from "./lib/near.ts";
import { nearToYocto } from "near-api-js";
import { type RuntimeJson, testnetRuntimeFromEnv } from "./lib/runtime.ts";
import { backupTraining, resetChainState, wipeAll } from "./lib/data.ts";
import { installSignalHandlers, killLeftovers, onCleanup, portInUse, run, shutdown, shutdownIfOrphaned, start, startWatchdog, trackPid, waitForHttp } from "./lib/proc.ts";
import { DATA_DIR, ROOT, RUNTIME_JSON, c, errMsg, loadDotEnv, log, retry, scriptStatus } from "./lib/util.ts";

// ---------------------------------------------------------------- args ----
type Mode = "offline" | "testnet" | "live";
const hadEnv = loadDotEnv();
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^\/\*\*?|^ \* ?/gm, ""));
  process.exit(0);
}
const flag = (f: string) => argv.includes(f);
const modeArg = argv.find((a) => !a.startsWith("-")) ?? argv.find((a) => a.startsWith("--mode="))?.slice(7);
const MODE: Mode = (modeArg || process.env.BAITNET_MODE || "offline") as Mode;
if (!["offline", "testnet", "live"].includes(MODE)) {
  console.error(`未知模式 "${MODE}"。可选：offline（默认）| testnet | live`);
  process.exit(2);
}
const CI = flag("--ci") || process.env.BAITNET_DEMO_CI === "1";
const EXPORT = flag("--export");
const NO_WEB = flag("--no-web");
const SKIP_FLOW = flag("--skip-flow");
const FULL = flag("--full");
const FRESH = flag("--fresh");
/** Fail instead of falling back to the in-memory registry when the sandbox cannot start (set in GitHub CI). */
// --ci requires a real chain by default (BAITNET_REQUIRE_CHAIN=0 to allow the memory fallback there too).
const REQUIRE_CHAIN = process.env.BAITNET_REQUIRE_CHAIN === "1" || (CI && process.env.BAITNET_REQUIRE_CHAIN !== "0");
/** User explicitly asked for no chain. */
const MEMORY_ONLY = process.env.BAITNET_REGISTRY === "memory";
/** Let --ci pass when other packages are not written yet (only during early development). */
const ALLOW_MISSING = process.env.BAITNET_ALLOW_MISSING === "1";

const SERVER_PORT = Number(process.env.BAITNET_SERVER_PORT || 8787);
const WEB_PORT = 5173;
const REGISTRY_WASM = join(ROOT, "contracts/registry/res/registry.wasm");
const VAULT_WASM = join(ROOT, "contracts/vault/res/vault.wasm");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const failures: string[] = [];
const fail = (msg: string) => {
  failures.push(msg);
  log.fail(msg);
};
const missing = (what: string, reason: string, hint: string) => {
  const msg = `${what} 还没就绪：${reason}`;
  if (CI && !ALLOW_MISSING) fail(msg);
  else log.warn(`${msg} — 跳过。${hint}`);
};

// -------------------------------------------------------------- runtime ----

function writeRuntime(rt: RuntimeJson) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(RUNTIME_JSON, `${JSON.stringify(rt, null, 2)}\n`, { mode: 0o600 });
  log.ok(`已写入 ${relative(ROOT, RUNTIME_JSON)}（含私钥，只在本地；data/ 已在 .gitignore）`);
}

// -------------------------------------------------------------- offline ----
const RESPONDERS = [
  { prefix: "wallet", name: "DemoWallet" },
  { prefix: "exchange", name: "DemoExchange" },
];

async function setupSandbox(): Promise<RuntimeJson> {
  log.step("1/4 检查预编译合约");
  if (!existsSync(REGISTRY_WASM)) {
    log.fail(`找不到 ${relative(ROOT, REGISTRY_WASM)}`);
    log.info("预编译 wasm 应随仓库提交（评委不需要 Rust）。如果你在开发合约：");
    log.info(`  ${c.bold("pnpm contracts:build")}   # 需要 Rust + cargo-near，见 README`);
    throw new Error("registry.wasm 缺失");
  }
  log.ok(`registry.wasm ${(statSync(REGISTRY_WASM).size / 1024).toFixed(0)} KB`);
  const hasVault = existsSync(VAULT_WASM);
  if (hasVault) log.ok(`vault.wasm ${(statSync(VAULT_WASM).size / 1024).toFixed(0)} KB`);
  else missing("vault.wasm", `${relative(ROOT, VAULT_WASM)} 不存在`, "仍会创建 vault 账户并给 agent 发限定 key，但链上不会有 pay() 拦截。");

  log.step("2/4 启动本地 NEAR sandbox");
  const t0 = Date.now();
  const sandbox = await startSandbox();
  trackPid((sandbox as unknown as { childProcess?: { pid?: number } }).childProcess?.pid, "sandbox");
  onCleanup(async () => {
    const cp = (sandbox as unknown as { childProcess?: { exitCode: number | null; signalCode: string | null } }).childProcess;
    // tearDown() waits for an 'exit' event that never comes if the process is already gone.
    if (cp && (cp.exitCode !== null || cp.signalCode !== null)) rmSync(sandbox.homeDir, { recursive: true, force: true });
    else await sandbox.tearDown();
  });
  log.ok(`sandbox RPC ${sandbox.rpcUrl}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  log.step("3/4 创建账户、部署并初始化合约");
  const chain = new Chain(sandbox.rpcUrl);
  const root = chain.account(sandboxRootKey(sandbox));
  const sub = (n: string) => `${n}.${SANDBOX_ROOT}`;

  const owner = await createFullAccount(root, sub("owner"), 50);
  const reporter = await createFullAccount(root, sub("reporter"), 20);
  const registry = await createFullAccount(root, sub("registry"), 50);
  const vault = await createFullAccount(root, sub("vault"), 200); // vault balance = what the agent may spend via pay()
  log.ok(`账户: ${[owner, reporter, registry, vault].map((a) => a.accountId).join(", ")}`);

  await deployAndInit(chain.account(registry), REGISTRY_WASM, "new", { owner: owner.accountId });
  log.ok(`registry 已部署并初始化 → ${registry.accountId}  (owner=${owner.accountId})`);

  // Agent: the ONLY key on this account is a function-call key for vault.pay.
  const agent = await createFunctionCallOnlyAccount(root, sub("agent"), 5, vault.accountId, ["pay"], 1);
  const keys = (await chain.accessKeys(agent.accountId)) as { keys: { access_key: { permission: unknown } }[] };
  const perms = keys.keys.map((k) => k.access_key.permission);
  const fc = perms[0] as { FunctionCall?: { receiver_id: string; method_names: string[] } } | string;
  if (perms.length === 1 && typeof fc === "object" && fc.FunctionCall?.receiver_id === vault.accountId && fc.FunctionCall.method_names.join() === "pay") {
    log.ok(`agent ${agent.accountId}: 唯一的 key 是 function-call key（receiver=${vault.accountId}, methods=[pay], allowance=1 NEAR）`);
  } else {
    fail(`agent access key 不符合预期: ${JSON.stringify(perms)}`);
  }

  if (hasVault) {
    const initArgs = process.env.VAULT_INIT_ARGS
      ? JSON.parse(process.env.VAULT_INIT_ARGS)
      : {
          owner: owner.accountId,
          agent: agent.accountId,
          registry: registry.accountId,
          per_tx_limit: nearToYocto(10).toString(),
          daily_limit: nearToYocto(50).toString(),
        };
    try {
      await deployAndInit(chain.account(vault), VAULT_WASM, "new", initArgs);
      log.ok(`vault 已部署并初始化 → ${vault.accountId}  new(${JSON.stringify(initArgs)})`);
    } catch (err) {
      fail(`vault 初始化失败：${errMsg(err)}（init 参数可用 VAULT_INIT_ARGS 覆盖）`);
    }
  }

  await call(chain.account(owner), registry.accountId, "add_reporter", { id: reporter.accountId });
  log.ok(`add_reporter(${reporter.accountId})`);

  const responders: RuntimeJson["accounts"]["responders"] = [];
  for (const r of RESPONDERS) {
    const acc = await createFullAccount(root, sub(r.prefix), 10);
    await call(chain.account(acc), registry.accountId, "register_responder", { name: r.name }, 0.01);
    responders.push({ ...acc, name: r.name });
    log.ok(`register_responder("${r.name}") ← ${acc.accountId}`);
  }

  const reporters = await chain.view<string[]>(registry.accountId, "list_reporters");
  if (!reporters.includes(reporter.accountId)) fail(`list_reporters 里没有 ${reporter.accountId}`);

  return {
    network: "sandbox",
    rpcUrl: sandbox.rpcUrl,
    registryContract: registry.accountId,
    vaultContract: vault.accountId,
    accounts: { owner, reporter, agent: { ...agent, keyKind: "function-call:vault:pay" }, responders },
  };
}

// -------------------------------------------------------------- testnet ----
async function setupTestnet(): Promise<RuntimeJson> {
  log.step("1/4 从 .env 读取测试网部署（不会创建账户、不会部署）");
  const rt = testnetRuntimeFromEnv();
  const rpcUrl = rt.rpcUrl;
  log.ok(`registry=${rt.registryContract} vault=${rt.vaultContract} rpc=${rpcUrl}`);

  log.step("2/4 检查测试网 RPC 与合约（只读）");
  const chain = new Chain(rpcUrl);
  try {
    const stats = await retry("读取 registry.stats()", () => chain.view(rt.registryContract, "stats"), { attempts: 4 });
    log.ok(`registry.stats() = ${JSON.stringify(stats)}`);
  } catch (err) {
    fail(`无法读取测试网合约 ${rt.registryContract}: ${errMsg(err)}`);
  }
  return rt;
}

// ------------------------------------------------------------ backend ----
function liveEnvReport(): Record<string, string> {
  const env: Record<string, string> = { BAITNET_MODE: MODE };
  // .env uses EVIDENCE_KEY; the backend reads BAITNET_EVIDENCE_KEY.
  if (process.env.EVIDENCE_KEY && !process.env.BAITNET_EVIDENCE_KEY) env.BAITNET_EVIDENCE_KEY = process.env.EVIDENCE_KEY;
  if (MODE !== "live" || EXPORT) {
    // offline/testnet: deterministic replay + fixtures even if keys are present in the shell/.env
    env.BAITNET_LLM = "replay";
    env.LIVE_INTENTS = "0";
    env.INTENTS_EXPLORER_JWT = "";
    return env;
  }
  // live: backend picks nearai → claude → replay from the keys (BAITNET_LLM, if set, forces one)
  if (process.env.BAITNET_LLM === "auto") env.BAITNET_LLM = "";
  const have = (k: string) => (process.env[k] ? c.green("有") : c.yellow("无"));
  log.info(`NEARAI_API_KEY: ${have("NEARAI_API_KEY")}   ANTHROPIC_API_KEY: ${have("ANTHROPIC_API_KEY")}   INTENTS_EXPLORER_JWT: ${have("INTENTS_EXPLORER_JWT")}   LIVE_INTENTS=${process.env.LIVE_INTENTS ?? "0"}`);
  if (!process.env.NEARAI_API_KEY && !process.env.ANTHROPIC_API_KEY) log.warn("没有任何 LLM key → 诱饵对话仍走回放（replay）");
  return env;
}

/**
 * CI (`--ci`) runs the backend's P0 smoke flow (`demo-flow`); everything else runs the
 * full storyline ①–⑥ (`demo -- --replay`, or without --replay in live mode).
 * `--ci --full` runs the full storyline in CI too.
 */
async function runDemoFlow(childEnv: Record<string, string>) {
  const smoke = CI && !FULL;
  const script = smoke ? "demo-flow" : "demo";
  const args = smoke ? [] : MODE === "live" && !EXPORT ? [] : ["--", "--replay"];
  log.step(smoke ? "4/4 后端冒烟流程 demo-flow（P0：对话 → 上链 → 守卫拦截）" : "4/4 按剧本 ①–⑥ 跑后端 demo");
  const st = scriptStatus("apps/agent", script);
  if (!st.ok) {
    missing(`后端 ${script}`, st.reason, "等后端完成 apps/agent 后重新运行 pnpm demo。");
    return;
  }
  const { code } = await run(PNPM, ["--filter", "@baitnet/agent", "run", script, ...args], { label: "agent", env: childEnv });
  if (code !== 0) fail(`${script} 退出码 ${code}`);
  else log.ok(`${script} 完成`);
}

/** Assertions for --ci: things a judge would expect to see after the run. */
async function verifyOnChain(rt: RuntimeJson) {
  log.step("检查关键输出");
  const chain = new Chain(rt.rpcUrl);
  try {
    const stats = await chain.view<Record<string, unknown>>(rt.registryContract, "stats");
    const alerts = await chain.view<{ id: number; address: string; chain: string; status: string }[]>(rt.registryContract, "list_alerts", { from_index: 0, limit: 50 });
    log.info(`registry.stats() = ${JSON.stringify(stats)}`);
    if (alerts.length === 0) {
      if (scriptStatus("apps/agent", CI && !FULL ? "demo-flow" : "demo").ok || !ALLOW_MISSING) fail("链上没有任何警报（剧本 ② 应写入 ≥1 条）");
    } else {
      log.ok(`链上 ${alerts.length} 条警报，例如 ${alerts[0]!.chain}:${alerts[0]!.address} [${alerts[0]!.status}]`);
      const hit = await chain.view<unknown>(rt.registryContract, "check", { chain: alerts[0]!.chain, address: alerts[0]!.address });
      if (hit) log.ok("registry.check() 命中已标记地址");
      else fail("registry.check() 没有命中刚写入的地址");
    }
  } catch (err) {
    fail(`读取 registry 失败: ${errMsg(err)}`);
  }
  if (rt.network === "sandbox" && existsSync(VAULT_WASM)) await verifyVault(rt, chain);
}

/** D6/D12 on-chain checks, signed with the agent's function-call key (sandbox only). */
async function verifyVault(rt: RuntimeJson, chain: Chain) {
  const agent = chain.account(rt.accounts.agent);
  const alerts = await chain.view<{ chain: string; address: string; status: string }[]>(rt.registryContract, "list_alerts", { from_index: 0, limit: 50 });
  const flagged = alerts.find((a) => a.chain === "near" && a.status === "Active");
  const clean = rt.accounts.responders[0]?.accountId ?? rt.accounts.owner.accountId;
  const amount = nearToYocto(0.1).toString();
  const txOk = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return { ok: true, err: "" };
    } catch (err) {
      return { ok: false, err: errMsg(err) };
    }
  };
  if (flagged) {
    const r = await txOk(() => call(agent, rt.vaultContract, "pay", { to: flagged.address, amount }));
    if (r.ok) fail(`vault.pay → ${flagged.address}（已标记）竟然成功了`);
    else log.ok(`vault.pay → ${flagged.address} 被链上拒绝（${r.err.slice(0, 80)}…）`);
  }
  const good = await txOk(() => call(agent, rt.vaultContract, "pay", { to: clean, amount }));
  if (good.ok) log.ok(`vault.pay → ${clean}（未标记）成功`);
  else fail(`vault.pay → ${clean}（未标记）失败: ${good.err}`);
  const bad = await txOk(() => agent.transfer({ receiverId: clean, amount: nearToYocto(0.1) }));
  if (bad.ok) fail("agent 的 key 竟然能直接转 NEAR");
  else log.ok("agent 的 key 不能直接转 NEAR");
}

async function startServer(childEnv: Record<string, string>): Promise<boolean> {
  const st = scriptStatus("apps/server", "start");
  if (!st.ok) {
    missing("后端 server", st.reason, "Dashboard 将没有数据。");
    return false;
  }
  if (await portInUse(SERVER_PORT)) {
    fail(`端口 ${SERVER_PORT} 已被占用（是不是上一次的 demo 还在跑？）`);
    return false;
  }
  const p = start(PNPM, ["--filter", "@baitnet/server", "run", "start"], { label: "server", env: { ...childEnv, PORT: String(SERVER_PORT) }, track: true });
  let alive = true;
  void p.done.then(() => (alive = false));
  const up = await waitForHttp(SERVER_PORT, "/alerts", 60_000, () => alive);
  if (!up) {
    fail(`server 没有在 60s 内响应 http://127.0.0.1:${SERVER_PORT}/alerts`);
    return false;
  }
  log.ok(`server 已启动 http://localhost:${SERVER_PORT}`);
  return true;
}

async function verifyServer() {
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/alerts`);
    const body = (await res.json()) as unknown;
    const n = Array.isArray(body) ? body.length : Array.isArray((body as { alerts?: unknown[] })?.alerts) ? (body as { alerts: unknown[] }).alerts.length : -1;
    if (!res.ok || n < 1) fail(`GET /alerts 返回 ${res.status}，警报数 ${n}`);
    else log.ok(`GET /alerts → ${n} 条警报`);
  } catch (err) {
    fail(`GET /alerts 失败: ${errMsg(err)}`);
  }
}

async function startWeb(childEnv: Record<string, string>): Promise<boolean> {
  const st = scriptStatus("apps/web", "dev");
  if (!st.ok) {
    missing("前端 web", st.reason, "");
    return false;
  }
  if (await portInUse(WEB_PORT)) {
    log.warn(`端口 ${WEB_PORT} 已被别的进程占用（可能是已经开着的前端 dev server），不再另起前端。`);
    log.warn(`如果那就是 BaitNet 前端，直接打开 http://localhost:${WEB_PORT} 即可；否则先关掉它再运行 pnpm demo。`);
    return false;
  }
  const p = start(PNPM, ["--filter", "@baitnet/web", "run", "dev"], { label: "web", env: childEnv, track: true });
  let alive = true;
  void p.done.then(() => (alive = false));
  if (!(await waitForHttp(WEB_PORT, "/", 90_000, () => alive))) {
    fail("web 没有在 90s 内启动");
    return false;
  }
  return true;
}

async function exportSnapshot(childEnv: Record<string, string>) {
  log.step("导出静态快照（D13）");
  const out = join(ROOT, "apps/web/public/snapshot.json");
  const st = scriptStatus("apps/server", "export-snapshot");
  if (!st.ok) return fail(`export-snapshot 还没就绪：${st.reason}`);
  mkdirSync(join(ROOT, "apps/web/public"), { recursive: true });
  const r = await run(PNPM, ["--filter", "@baitnet/server", "run", "export-snapshot"], { label: "export", env: { ...childEnv, SNAPSHOT_OUT: out } });
  if (r.code !== 0) return fail(`export-snapshot 退出码 ${r.code}`);
  if (!existsSync(out)) return fail(`没有生成 ${relative(ROOT, out)}`);
  const text = readFileSync(out, "utf8");
  // The snapshot gets published; it must never carry keys.
  if (/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(text) || /"privateKey"|sk-ant-|BEGIN [A-Z ]*PRIVATE KEY/.test(text)) {
    return fail("snapshot.json 里出现了疑似私钥/密钥，拒绝继续（不要发布这个文件）");
  }
  const snap = JSON.parse(text) as { alerts?: unknown[] };
  log.ok(`${relative(ROOT, out)}  ${(text.length / 1024).toFixed(0)} KB, ${snap.alerts?.length ?? 0} 条警报`);

  const b = scriptStatus("apps/web", "build");
  if (!b.ok) return fail(`web build 还没就绪：${b.reason}`);
  const rb = await run(PNPM, ["--filter", "@baitnet/web", "run", "build"], { label: "web-build", env: { ...childEnv, VITE_SNAPSHOT: "1" } });
  if (rb.code !== 0) return fail(`web build 退出码 ${rb.code}`);
  log.ok("apps/web/dist 已生成，可静态托管（vercel.json 已配置）");
}

// ----------------------------------------------------------------- main ----
async function main() {
  installSignalHandlers();
  shutdownIfOrphaned();
  const leftovers = await killLeftovers();
  if (leftovers) log.warn(`清理了上次 demo 残留的 ${leftovers} 个进程（来自 data/.demo-pids.json）`);
  startWatchdog();
  const exportMode = EXPORT;
  const effectiveMode: Mode = exportMode ? "offline" : MODE;
  console.log(c.bold(`\nBaitNet demo — 模式 ${effectiveMode}${CI ? " (--ci)" : ""}${exportMode ? " (export)" : ""}`));
  if (effectiveMode === "offline") console.log(c.dim("  不需要任何 API key；本地 sandbox 链 + 回放 LLM + 样例数据"));
  else if (!hadEnv) console.log(c.yellow("  没有找到 .env —— 先 cp .env.example .env 并填写"));

  // Expert data (training DB, arena sessions, evidence…) survives restarts; back it up first.
  if (FRESH) await wipeAll();
  else await backupTraining();

  let rt: RuntimeJson | undefined;
  const useTestnet = effectiveMode === "testnet" || (effectiveMode === "live" && !!process.env.REGISTRY_CONTRACT_ID);
  if (effectiveMode === "live" && !useTestnet) log.warn("live 模式：.env 里没有 REGISTRY_CONTRACT_ID，链部分用本地 sandbox");
  if (useTestnet) {
    rt = await setupTestnet();
  } else if (MEMORY_ONLY) {
    resetChainState();
    log.warn("BAITNET_REGISTRY=memory：按要求跳过本地链，使用内存版 registry");
  } else {
    resetChainState();
    try {
      rt = await setupSandbox();
    } catch (err) {
      if (REQUIRE_CHAIN) {
        log.fail(`本地 NEAR 链没能启动：${errMsg(err)}`);
        if (CI) log.info("--ci 要求真链。只想验证链下部分：BAITNET_REQUIRE_CHAIN=0 pnpm demo --ci");
        throw new Error("没有本地链（--ci / BAITNET_REQUIRE_CHAIN=1 不允许降级到内存模式）");
      }
      log.fail(`本地 NEAR 链没能启动：${errMsg(err)}`);
      console.log(c.yellow(c.bold("\n  ⚠ 降级：改用后端的内存版 registry（BAITNET_REGISTRY=memory）。")));
      console.log(c.yellow("    剧本、守卫拦截、Dashboard 都照常，但警报不会真的写上链，vault 链上拦截不演示。"));
      console.log(c.yellow("    修好网络后（或设置 SANDBOX_ARTIFACT_URL / NEAR_SANDBOX_BIN_PATH）重新运行即可用真链。\n"));
    }
  }
  const childEnv: Record<string, string> = { ...liveEnvReport() };
  if (rt) {
    writeRuntime(rt);
    Object.assign(childEnv, { BAITNET_RUNTIME: RUNTIME_JSON, NEAR_RPC_URL: rt.rpcUrl, NEAR_NETWORK: rt.network });
    // The sandbox dies with this process; a stale runtime.json would point the backend at a dead RPC.
    if (rt.network === "sandbox") onCleanup(() => rmSync(RUNTIME_JSON, { force: true }));
  } else {
    rmSync(RUNTIME_JSON, { force: true });
    childEnv.BAITNET_REGISTRY = "memory";
  }

  if (!SKIP_FLOW) await runDemoFlow(childEnv);

  if (CI) {
    if (rt) await verifyOnChain(rt);
    else log.warn("内存模式：跳过链上检查");
    if (await startServer(childEnv)) await verifyServer();
  } else if (exportMode) {
    await exportSnapshot(childEnv);
  } else {
    if (failures.length) log.warn(`前面有 ${failures.length} 个问题，仍然启动服务以便排查`);
    const serverUp = await startServer(childEnv);
    const webUp = NO_WEB ? false : await startWeb(childEnv);
    console.log("");
    if (webUp) console.log(c.bold(c.green(`  ➜  打开 http://localhost:${WEB_PORT}`)));
    if (serverUp) console.log(`     后端 API  http://localhost:${SERVER_PORT}/alerts`);
    if (rt?.network === "sandbox") console.log(`     NEAR RPC  ${rt.rpcUrl}  （sandbox 会在退出时销毁）`);
    if (!rt) console.log(c.yellow(c.bold("     ⚠ 内存模式：没有本地链，链上部分（上链、vault 拦截）没有验证")));
    console.log(c.dim("     Ctrl-C 退出（会关闭 server、web 和 sandbox）\n"));
    await new Promise(() => {}); // until signal
  }

  if (failures.length) {
    console.log(`\n${c.red(c.bold(`✗ ${failures.length} 项失败：`))}`);
    for (const f of failures) console.log(c.red(`  - ${f}`));
    return shutdown(1);
  }
  if (!rt) {
    // Only reachable with BAITNET_REQUIRE_CHAIN=0 or BAITNET_REGISTRY=memory.
    console.log(`\n${c.yellow(c.bold("⚠ 链下部分通过 —— 内存模式，没有验证链上部分（上链、registry.check、vault 拦截）"))}`);
    return shutdown(CI && !MEMORY_ONLY && process.env.BAITNET_REQUIRE_CHAIN !== "0" ? 1 : 0);
  }
  console.log(`\n${c.green(c.bold("✓ 全部通过"))}`);
  return shutdown(0);
}

main().catch(async (err) => {
  log.fail(errMsg(err));
  if (process.env.DEBUG) console.error(err);
  await shutdown(1);
});
