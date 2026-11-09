// Detached watchdog for scripts/demo.ts (plain Node, no deps).
// argv: <demoPid> <pidFile> <runtimeJson>
// When the demo process is gone but the PID file still exists (= no clean shutdown),
// kill every recorded process (group) and remove the stale runtime.json.
import { existsSync, readFileSync, rmSync } from "node:fs";

const [demoPid, pidFile, runtimeJson] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sig = (e, s) => {
  try {
    process.kill(e.group ? -e.pid : e.pid, s);
  } catch {}
};

const timer = setInterval(() => {
  if (alive(demoPid)) return;
  clearInterval(timer);
  if (!existsSync(pidFile)) process.exit(0); // clean shutdown already happened
  let entries = [];
  try {
    const f = JSON.parse(readFileSync(pidFile, "utf8"));
    if (f.owner !== demoPid) process.exit(0); // a newer demo owns the file
    entries = f.entries ?? [];
  } catch {}
  for (const e of entries) sig(e, "SIGTERM");
  setTimeout(() => {
    for (const e of entries) if (alive(e.pid)) sig(e, "SIGKILL");
    rmSync(pidFile, { force: true });
    if (runtimeJson) rmSync(runtimeJson, { force: true });
    process.exit(0);
  }, 3000);
}, 500);
