/**
 * Local NEAR sandbox + deployment helpers for the offline demo.
 *
 * Sandbox binary: prebuilt `near-sandbox` (Linux x86_64 / aarch64, macOS arm64)
 * from build.nearprotocol.com (S3), the same artifact the `near-sandbox` npm
 * package uses. We download it ourselves (resumable, stall timeout, retries) into
 * `.cache/near-sandbox/<version>/` so it is fetched at most once, then hand the
 * path to the package via NEAR_SANDBOX_BIN_PATH.
 *
 * Overrides (all optional):
 *   NEAR_SANDBOX_BIN_PATH   use an existing binary, skip the download
 *   SANDBOX_ARTIFACT_URL    download the tar.gz from a mirror instead of S3
 *   NEAR_SANDBOX_VERSION    binary version (default: the package default)
 *   NEAR_SANDBOX_RPC_PORT   RPC port (default 3030, random if busy)
 *   SANDBOX_DOWNLOAD_STALL_SECS (20) / SANDBOX_DOWNLOAD_RETRY_SECS (20)  download tuning
 */
import { spawnSync } from "node:child_process";
import { type WriteStream, chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { DEFAULT_NEAR_SANDBOX_VERSION, Sandbox } from "near-sandbox";
import { portInUse } from "./proc.ts";
import { ROOT, c, errMsg, log, retry } from "./util.ts";
// same retry (429/5xx, Retry-After) + comma-separated failover policy as the backend
import { ResilientRpcProvider } from "../../packages/guard/src/rpc-provider.ts";

/** The sandbox genesis validator account; we create every demo account under it. */
export const SANDBOX_ROOT = "test.near";

/** Full-access key of `test.near` (generated per sandbox in <home>/validator_key.json). */
export function sandboxRootKey(sb: Sandbox): KeyedAccount {
  const k = JSON.parse(readFileSync(join(sb.homeDir, "validator_key.json"), "utf8")) as { account_id: string; secret_key?: string; private_key?: string };
  if (k.account_id !== SANDBOX_ROOT) throw new Error(`sandbox validator 是 ${k.account_id}，预期 ${SANDBOX_ROOT}`);
  return { accountId: k.account_id, privateKey: (k.secret_key ?? k.private_key) as KeyPairString };
}

export interface KeyedAccount {
  accountId: string;
  privateKey: KeyPairString;
}

function platformDir(): string {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "Linux-x86_64";
  if (platform === "linux" && arch === "arm64") return "Linux-aarch64";
  if (platform === "darwin" && arch === "arm64") return "Darwin-arm64";
  throw new Error(
    `near-sandbox 没有 ${platform}-${arch} 的预编译二进制（支持 Linux x64/arm64、macOS arm64）。` +
      `可以自行编译 nearcore 的 sandbox 并设置 NEAR_SANDBOX_BIN_PATH。`,
  );
}

/**
 * Download the sandbox tarball ourselves instead of relying on the package's
 * downloader: ours resumes partial downloads (HTTP Range), aborts on stalls,
 * retries, and shows progress. Returns the binary path.
 */
export async function ensureSandboxBinary(version = process.env.NEAR_SANDBOX_VERSION || DEFAULT_NEAR_SANDBOX_VERSION): Promise<string> {
  if (process.env.NEAR_SANDBOX_BIN_PATH) {
    if (!existsSync(process.env.NEAR_SANDBOX_BIN_PATH)) throw new Error(`NEAR_SANDBOX_BIN_PATH=${process.env.NEAR_SANDBOX_BIN_PATH} 不存在`);
    return process.env.NEAR_SANDBOX_BIN_PATH;
  }
  const dir = join(ROOT, ".cache", "near-sandbox", version);
  const bin = join(dir, "near-sandbox");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  // Serialize concurrent downloads (several demos/tests starting at once share the cache).
  const release = await acquireDirLock(join(dir, ".download.lock"));
  try {
    if (existsSync(bin)) return bin; // another process finished while we waited
    return await downloadAndExtract(dir, bin, version);
  } finally {
    release();
  }
}

async function acquireDirLock(lockDir: string): Promise<() => void> {
  const STALE_MS = 3 * 60_000;
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      // Heartbeat so a slow (but alive) download is never treated as stale.
      const beat = setInterval(() => {
        try {
          utimesSync(lockDir, new Date(), new Date());
        } catch {
          /* ignore */
        }
      }, 30_000);
      beat.unref();
      return () => {
        clearInterval(beat);
        rmSync(lockDir, { recursive: true, force: true });
      };
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // vanished between mkdir and stat
      }
      if (!announced) log.info("另一个进程正在下载 sandbox 二进制，等待它完成…");
      announced = true;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** DNS failures, refused connections, HTTP 4xx: retrying will not help. */
function isPermanentNetError(msg: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|EAI_NONAME|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|HTTP 4\d\d|Invalid URL|unknown scheme|not implemented/i.test(msg) && !/HTTP 408|HTTP 429/.test(msg);
}

async function waitWithHints(ms: number) {
  const end = Date.now() + ms;
  let next = Date.now() + 5000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
    if (Date.now() >= next && Date.now() < end) {
      log.info(c.dim("  …等待重试。可以按 Ctrl-C，或设 BAITNET_REGISTRY=memory 跳过链"));
      next += 5000;
    }
  }
}

async function downloadOnce(url: string, tgz: string, STALL_MS: number): Promise<void> {
  const have = existsSync(tgz) ? statSync(tgz).size : 0;
  const ctrl = new AbortController();
  const stall = () => ctrl.abort(new Error(`${STALL_MS / 1000}s 没有收到数据`));
  let stallTimer = setTimeout(stall, STALL_MS);
  const kick = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(stall, STALL_MS);
  };
  const tty = process.stdout.isTTY;
  let out: WriteStream | undefined;
  let progressShown = false;
  try {
    const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctrl.signal });
    if (res.status === 416) return; // already complete
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    // Only append when the server really resumed at our offset; otherwise start over.
    const resumed = res.status === 206 && (res.headers.get("content-range") ?? "").startsWith(`bytes ${have}-`);
    const total = Number(res.headers.get("content-length") || 0) + (resumed ? have : 0);
    out = createWriteStream(tgz, { flags: resumed ? "a" : "w" });
    let got = resumed ? have : 0;
    let lastPrint = 0;
    let lastDecile = -1;
    const print = (force = false) => {
      const pct = total ? (got / total) * 100 : 0;
      const decile = Math.floor(pct / 10);
      // TTY: redraw twice a second. Logs/CI: a line every 10% or every 5 s.
      if (!force && Date.now() - lastPrint < (tty ? 500 : 5000) && (tty || decile === lastDecile)) return;
      lastPrint = Date.now();
      lastDecile = decile;
      progressShown = true;
      const line = `  … ${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB${total ? ` ${pct.toFixed(0)}%` : ""}`;
      if (tty) process.stdout.write(`\r${line}`);
      else console.log(line);
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      kick();
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out!.once("drain", () => r()));
      print();
    }
    print(true);
    if (total && got < total) throw new Error(`连接提前结束 ${got}/${total} bytes`);
  } finally {
    clearTimeout(stallTimer);
    if (tty && progressShown) process.stdout.write("\n");
    // Always flush + close before the next attempt reads the file size, otherwise
    // buffered bytes from this attempt would land after the resumed ones.
    if (out) await new Promise<void>((r) => out!.end(() => r()));
  }
}

async function downloadAndExtract(dir: string, bin: string, version: string): Promise<string> {

  const url =
    process.env.SANDBOX_ARTIFACT_URL ||
    `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platformDir()}/${version}/near-sandbox.tar.gz`;
  const tgz = join(dir, "near-sandbox.tar.gz.part");
  log.info(`下载 NEAR sandbox ${version}（约 30 MB，只下载一次）: ${c.dim(url)}`);

  log.info(c.dim(`  不想等：Ctrl-C 后用 BAITNET_REGISTRY=memory pnpm demo 跳过链；或设 NEAR_SANDBOX_BIN_PATH / SANDBOX_ARTIFACT_URL`));

  const STALL_MS = Number(process.env.SANDBOX_DOWNLOAD_STALL_SECS || 20) * 1000;
  // Total time we are willing to *wait between failed attempts that made no progress*.
  // Attempts that downloaded something reset the budget (slow but alive networks keep going).
  const BUDGET_MS = Number(process.env.SANDBOX_DOWNLOAD_RETRY_SECS || 20) * 1000;
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const before = existsSync(tgz) ? statSync(tgz).size : 0;
    try {
      await downloadOnce(url, tgz, STALL_MS);
      break;
    } catch (err) {
      const msg = errMsg(err);
      if (isPermanentNetError(msg)) {
        throw new Error(`下载 near-sandbox 失败（不可恢复，不再重试）：${msg}`);
      }
      const after = existsSync(tgz) ? statSync(tgz).size : 0;
      if (after > before) waited = 0; // made progress → fresh budget
      const wait = Math.min(2000 * 2 ** Math.min(attempt - 1, 3), BUDGET_MS - waited);
      if (wait <= 0) throw new Error(`下载 near-sandbox 失败（已重试 ${attempt} 次，约 ${Math.round(BUDGET_MS / 1000)}s 内没有进展）：${msg}`);
      log.warn(`下载 near-sandbox 失败（第 ${attempt} 次）：${msg} — ${Math.round(wait / 1000)}s 后续传重试`);
      await waitWithHints(wait);
      waited += wait;
    }
  }

  const gz = spawnSync("gzip", ["-t", tgz], { stdio: "ignore" });
  if (gz.status !== 0) {
    rmSync(tgz, { force: true });
    throw new Error("下载的 near-sandbox.tar.gz 校验失败（已删除，重新运行即可）");
  }
  const tmp = mkdtempSync(join(dir, "x-"));
  const tar = spawnSync("tar", ["-xzf", tgz, "-C", tmp, "--strip-components=1"], { stdio: "inherit" });
  if (tar.status !== 0) {
    rmSync(tgz, { force: true });
    throw new Error("解压 near-sandbox.tar.gz 失败（已删除损坏的下载，重新运行即可）");
  }
  renameSync(join(tmp, "near-sandbox"), bin);
  chmodSync(bin, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tgz, { force: true });
  log.ok(`sandbox 二进制已缓存: ${bin}`);
  return bin;
}

/**
 * The macOS sandbox build links /opt/homebrew/opt/xz/lib/liblzma.5.dylib. Without
 * Homebrew xz it aborts at load time; macOS ships its own liblzma in /usr/lib
 * (dyld shared cache), so a fallback path is enough. Harmless elsewhere.
 */
function fixMacDylibs() {
  if (process.platform !== "darwin") return;
  const cur = process.env.DYLD_FALLBACK_LIBRARY_PATH;
  const extra = ["/opt/homebrew/lib", "/usr/local/lib", "/usr/lib"];
  process.env.DYLD_FALLBACK_LIBRARY_PATH = [...(cur ? cur.split(":") : []), ...extra.filter((p) => !cur?.split(":").includes(p))].join(":");
}

export async function startSandbox(): Promise<Sandbox> {
  fixMacDylibs();
  // First start on a slow CI box can take longer than the package's 10s default.
  process.env.NEAR_RPC_TIMEOUT_SECS ??= "30";
  const version = process.env.NEAR_SANDBOX_VERSION || undefined;
  process.env.NEAR_SANDBOX_BIN_PATH = await ensureSandboxBinary(version);
  const wanted = Number(process.env.NEAR_SANDBOX_RPC_PORT || 3030);
  // Check first: if another sandbox/demo already holds the port, go straight to a random free one.
  const preferredPort = (await portInUse(wanted)) ? undefined : wanted;
  if (preferredPort === undefined) log.warn(`端口 ${wanted} 已被占用，sandbox 改用随机空闲端口（会写进 runtime.json 的 rpcUrl）`);

  return retry(
    "启动 NEAR sandbox",
    async (attempt) => {
      // Try the fixed port first (nice URLs in logs), fall back to a random one.
      const rpcPort = attempt === 1 ? preferredPort : undefined; // retries always take a random free port
      try {
        return await Sandbox.start({ version, config: { rpcPort } });
      } catch (err) {
        const msg = errMsg(err);
        if (rpcPort && /Port .* not available|lock port/i.test(msg)) {
          log.warn(`端口 ${rpcPort} 被占用，改用随机端口`);
          return await Sandbox.start({ version, config: {} });
        }
        // The binary itself cannot run (wrong platform, missing system library): retrying won't help.
        if (/doesn't respond|corrupted|ENOEXEC|EACCES|BinaryNotFound|does not exist/i.test(msg)) throw Object.assign(err as object, { bail: true });
        throw err;
      }
    },
    { attempts: 3, baseMs: 3000 },
  );
}

export class Chain {
  readonly provider: ResilientRpcProvider;
  /** `rpcUrl` may be a comma-separated list of endpoints (failover). */
  constructor(readonly rpcUrl: string) {
    this.provider = new ResilientRpcProvider(rpcUrl, { log: (l) => log.info(c.dim(l)) });
  }

  account(a: KeyedAccount): Account {
    return new Account(a.accountId, this.provider, new KeyPairSigner(KeyPair.fromString(a.privateKey)));
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}, finality: "optimistic" | "final" = "optimistic"): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args, blockQuery: { finality } } as Parameters<ResilientRpcProvider["callFunction"]>[0])) as T;
  }

  async accessKeys(accountId: string): Promise<{ keys: { public_key: string; access_key: { permission: unknown } }[] }> {
    return this.provider.viewAccessKeyList({ accountId, finalityQuery: { finality: "optimistic" } });
  }
}

/** Create `<name>.<parent>` with a fresh full-access key. */
export async function createFullAccount(parent: Account, accountId: string, nearAmount: number): Promise<KeyedAccount> {
  const kp = KeyPair.fromRandom("ed25519");
  await parent.createAccount({ newAccountId: accountId, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto(nearAmount) });
  return { accountId, privateKey: kp.toString() as KeyPairString };
}

/**
 * Create an account whose ONLY key is a function-call key restricted to
 * `contractId` and `methods` (no full-access key ever exists for it).
 */
export async function createFunctionCallOnlyAccount(
  parent: Account,
  accountId: string,
  nearAmount: number,
  contractId: string,
  methods: string[],
  allowanceNear: number,
): Promise<KeyedAccount> {
  const kp = KeyPair.fromRandom("ed25519");
  await parent.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(nearAmount)),
      actions.addFunctionCallAccessKey(kp.getPublicKey(), contractId, methods, nearToYocto(allowanceNear)),
    ],
  });
  return { accountId, privateKey: kp.toString() as KeyPairString };
}

/** Deploy wasm and call the init method in one transaction (needed for #[private] init). */
export async function deployAndInit(contract: Account, wasmPath: string, initMethod: string, initArgs: object): Promise<void> {
  const code = new Uint8Array(readFileSync(wasmPath));
  await contract.signAndSendTransaction({
    receiverId: contract.accountId,
    actions: [actions.deployContract(code), actions.functionCall(initMethod, initArgs, teraToGas(100), 0n)],
  });
}

export async function call(from: Account, contractId: string, methodName: string, args: object, depositNear = 0): Promise<unknown> {
  return from.callFunction({ contractId, methodName, args, deposit: nearToYocto(depositNear), gas: teraToGas(100) });
}
