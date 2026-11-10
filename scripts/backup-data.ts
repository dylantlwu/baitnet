/**
 * Manual snapshot of $BAITNET_DATA_DIR into ONE file — for Railway (no cron, no sqlite3 CLI),
 * same content as deploy/backup.sh on the VPS:
 *   - every *.sqlite via `VACUUM INTO` (consistent copy while the server keeps running) + quick_check
 *   - every other file/dir in the data dir (evidence/, arena/, eval/, *.json, *.jsonl, …)
 *   - NOT included: backups/ itself, runtime.json (holds testnet private keys; rebuilt from env on start),
 *     live *.sqlite / -wal / -shm files (replaced by the VACUUM copies)
 *
 *   tsx scripts/backup-data.ts            → $BAITNET_DATA_DIR/backups/manual/baitnet-<UTC ts>.tar.gz
 *   (Railway container: `baitnet backup`, see docs/deploy/Railway部署.md)
 *
 * Keeps the newest 5 archives (BAITNET_BACKUP_KEEP). Prints only the path and size — no data, no keys.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT, errMsg } from "./lib/util.ts";

const data = process.env.BAITNET_DATA_DIR || join(ROOT, "data");
const keep = Math.max(1, Number(process.env.BAITNET_BACKUP_KEEP ?? 5));
const outDir = join(data, "backups", "manual");
const SKIP = /^(backups|runtime\.json|restore-pending(\.tmp)?)$|\.sqlite(-wal|-shm|-journal)?$/;

try {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[-:.]/g, "");
  const stage = mkdtempSync(join(outDir, ".stage-"));
  try {
    const entries = readdirSync(data);
    let n = 0;
    for (const name of entries.filter((f) => f.endsWith(".sqlite"))) {
      const dest = join(stage, name);
      const db = new DatabaseSync(join(data, name));
      try {
        db.exec("PRAGMA busy_timeout = 10000");
        db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      } finally {
        db.close();
      }
      const copy = new DatabaseSync(dest, { readOnly: true });
      const row = copy.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      copy.close();
      if (row?.quick_check !== "ok") throw new Error(`integrity check failed: ${name}`);
      n++;
    }
    const files = entries.filter((f) => !SKIP.test(f));
    const out = join(outDir, `baitnet-${ts}.tar.gz`);
    // sqlite copies from the stage dir, everything else straight from the data dir
    const tarArgs = ["-czf", out, "-C", stage, ...readdirSync(stage), ...(files.length ? ["-C", data, ...files] : [])];
    const r = spawnSync("tar", tarArgs, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`tar exited with ${r.status ?? r.signal}`);
    const old = readdirSync(outDir)
      .filter((f) => /^baitnet-.*\.tar\.gz$/.test(f))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of old) rmSync(join(outDir, f), { force: true });
    const mb = (statSync(out).size / 1048576).toFixed(2);
    console.log(`backup ok: ${out} (${n} sqlite, ${files.length} other entries, ${mb} MB)`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
} catch (err) {
  console.error(`backup: ${errMsg(err)}`);
  process.exit(1);
}
