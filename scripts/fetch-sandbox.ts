/**
 * `pnpm sandbox:fetch` — download (with retries) and smoke-test the local NEAR
 * sandbox binary, then exit. Useful to pre-warm a machine or CI cache before
 * `pnpm demo`. Prints the binary location and the sandbox RPC status.
 */
import { startSandbox } from "./lib/near.ts";
import { c, errMsg, log } from "./lib/util.ts";

const t0 = Date.now();
log.step("下载并启动 NEAR sandbox（首次运行会下载约几十 MB）");
try {
  const sb = await startSandbox();
  const status = (await (await fetch(`${sb.rpcUrl}/status`)).json()) as { version?: { version?: string }; chain_id?: string };
  log.ok(`sandbox 已就绪: ${sb.rpcUrl}  chain_id=${status.chain_id} neard=${status.version?.version}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  log.info(c.dim(`二进制缓存: ${process.env.NEAR_SANDBOX_BIN_PATH ?? process.env.DIR_TO_DOWNLOAD_BINARY}`));
  await sb.tearDown();
  process.exit(0);
} catch (err) {
  log.fail(`sandbox 启动失败: ${errMsg(err)}`);
  log.info("可选：设置 SANDBOX_ARTIFACT_URL 指向镜像，或 NEAR_SANDBOX_BIN_PATH 指向已有的 near-sandbox 二进制。");
  process.exit(1);
}
