/**
 * Production helper: write $BAITNET_DATA_DIR/runtime.json (mode 600) from env vars.
 * Runs as systemd ExecStartPre before every server start (deploy/setup-server.sh), so
 * /etc/baitnet/env stays the single source of truth for chain config and keys.
 *
 *   BAITNET_DATA_DIR=/var/lib/baitnet tsx scripts/write-runtime.ts
 *
 * If BAITNET_REGISTRY=memory, removes runtime.json instead (server uses the memory registry).
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testnetRuntimeFromEnv } from "./lib/runtime.ts";
import { ROOT, errMsg } from "./lib/util.ts";

const dir = process.env.BAITNET_DATA_DIR || join(ROOT, "data");
const out = process.env.BAITNET_RUNTIME || join(dir, "runtime.json");
try {
  if (process.env.BAITNET_REGISTRY === "memory") {
    rmSync(out, { force: true });
    console.log(`BAITNET_REGISTRY=memory → removed ${out}`);
    process.exit(0);
  }
  const rt = testnetRuntimeFromEnv(process.env, "/etc/baitnet/env");
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(rt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`wrote ${out} (network=${rt.network} registry=${rt.registryContract} rpc=${rt.rpcUrl})`);
} catch (err) {
  console.error(`write-runtime: ${errMsg(err)}`);
  process.exit(1);
}
