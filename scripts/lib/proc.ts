/**
 * Child-process management for the demo: prefixed output, process-group kill,
 * and one cleanup path for Ctrl-C / errors / normal exit.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ROOT, c, sleep } from "./util.ts";

type Cleanup = () => Promise<void> | void;
const cleanups: Cleanup[] = [];
const children = new Set<ChildProcess>();
let shuttingDown = false;

// ---------------------------------------------------------------------------
// PID file: every long-lived process we start is recorded in data/.demo-pids.json
// so that (a) a watchdog can kill them if this process is SIGKILLed, and (b) the
// next `pnpm demo` can clean up leftovers from a run that died uncleanly.
// ---------------------------------------------------------------------------
export const PID_FILE = join(DATA_DIR, ".demo-pids.json");
interface PidEntry {
  pid: number;
  /** kill the whole process group (-pid) */
  group: boolean;
  label: string;
}
interface PidFile {
  owner: number;
  entries: PidEntry[];
}
const tracked: PidEntry[] = [];

function writePidFile() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ owner: process.pid, entries: tracked } satisfies PidFile, null, 2));
}

export function trackPid(pid: number | undefined, label: string, group = false) {
  if (!pid) return;
  tracked.push({ pid, group, label });
  writePidFile();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Command line of a pid ("" if gone) — guards against killing a recycled pid. */
function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const OURS = /near-sandbox|neard|vite|tsx|pnpm|node/;

function signalEntry(e: PidEntry, sig: NodeJS.Signals) {
  try {
    process.kill(e.group ? -e.pid : e.pid, sig);
  } catch {
    /* gone */
  }
}

/** Kill processes left behind by an earlier demo run that did not shut down cleanly. */
export async function killLeftovers(): Promise<number> {
  if (!existsSync(PID_FILE)) return 0;
  let file: PidFile;
  try {
    file = JSON.parse(readFileSync(PID_FILE, "utf8")) as PidFile;
  } catch {
    rmSync(PID_FILE, { force: true });
    return 0;
  }
  if (file.owner !== process.pid && alive(file.owner) && OURS.test(commandOf(file.owner)) && /demo\.ts/.test(commandOf(file.owner))) {
    throw new Error(`另一个 pnpm demo 正在运行（pid ${file.owner}）。先停掉它（Ctrl-C 或 kill ${file.owner}）。`);
  }
  const victims = file.entries.filter((e) => alive(e.pid) && OURS.test(commandOf(e.pid)));
  for (const e of victims) signalEntry(e, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (victims.some((e) => alive(e.pid)) && Date.now() < deadline) await sleep(100);
  for (const e of victims) if (alive(e.pid)) signalEntry(e, "SIGKILL");
  rmSync(PID_FILE, { force: true });
  return victims.length;
}

/**
 * Detached watchdog: if this process disappears without cleaning up (SIGKILL, parent
 * killed with no signal forwarding), it kills everything in the PID file.
 */
export function startWatchdog() {
  const wd = spawn(process.execPath, [join(ROOT, "scripts/lib/watchdog.mjs"), String(process.pid), PID_FILE, join(DATA_DIR, "runtime.json")], {
    detached: true,
    stdio: "ignore",
  });
  wd.unref();
}

/**
 * If whoever started us (pnpm / tsx) dies, we get re-parented. Treat that like a
 * signal: some wrappers do not forward SIGTERM/SIGHUP to their children.
 */
export function shutdownIfOrphaned() {
  const initial = process.ppid;
  setInterval(() => {
    if (process.ppid !== initial) {
      process.stdout.write(`\n${c.dim("父进程已退出，正在关闭所有子进程和 sandbox…")}\n`);
      void shutdown(0, true);
    }
  }, 1000).unref();
}

export function onCleanup(fn: Cleanup) {
  cleanups.push(fn);
}

const colors = [c.magenta, c.blue, c.green, c.yellow, c.cyan];
let colorIdx = 0;

export interface RunOpts {
  label: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** collect stdout+stderr text (for --ci assertions) */
  capture?: boolean;
  /** record in the PID file (long-lived services) */
  track?: boolean;
}

function pipePrefixed(stream: NodeJS.ReadableStream | null, prefix: string, sink: (s: string) => void, buf?: string[]) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf?.push(chunk);
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    // While we are shutting services down on purpose, their "killed by SIGTERM" noise is not news.
    if (shuttingDown) return;
    for (const l of lines) sink(`${prefix} ${l}\n`);
  });
  stream.on("end", () => {
    if (pending && !shuttingDown) sink(`${prefix} ${pending}\n`);
  });
}

export function start(cmd: string, args: string[], opts: RunOpts): { child: ChildProcess; output: string[]; done: Promise<number> } {
  const color = colors[colorIdx++ % colors.length]!;
  const prefix = color(`[${opts.label}]`);
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? "1" : "0", ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so we can kill pnpm + tsx + vite grandchildren together.
    detached: process.platform !== "win32",
  });
  children.add(child);
  if (opts.track) trackPid(child.pid, opts.label, true);
  const output: string[] = [];
  pipePrefixed(child.stdout, prefix, (s) => process.stdout.write(s), opts.capture ? output : undefined);
  pipePrefixed(child.stderr, prefix, (s) => process.stderr.write(s), opts.capture ? output : undefined);
  const done = new Promise<number>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`${prefix} ${c.red(`无法启动 ${cmd}: ${err.message}`)}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  return { child, output, done };
}

/** Run to completion; resolves with exit code and captured output. */
export async function run(cmd: string, args: string[], opts: RunOpts): Promise<{ code: number; output: string }> {
  const p = start(cmd, args, { ...opts, capture: true });
  const code = await p.done;
  return { code, output: p.output.join("") };
}

function killTree(child: ChildProcess, sig: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    /* already gone */
  }
}

const withTimeout = (p: Promise<unknown> | unknown, ms: number) =>
  Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);

function groupAlive(pgid: number | undefined): boolean {
  if (!pgid || process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function shutdown(code: number, announce = false): Promise<never> {
  if (shuttingDown) return new Promise<never>(() => {}); // first shutdown will exit
  shuttingDown = true;
  // Signal everything at once (child process groups + tracked pids like the sandbox).
  for (const ch of children) killTree(ch, "SIGTERM");
  for (const e of tracked) signalEntry(e, "SIGTERM");
  const deadline = Date.now() + 5000;
  // Wait for whole process groups (pnpm exits before its tsx/vite grandchildren do).
  const groups = [...children].map((ch) => ch.pid);
  const anyAlive = () => groups.some(groupAlive) || tracked.some((e) => (e.group ? groupAlive(e.pid) : alive(e.pid)));
  while (anyAlive() && Date.now() < deadline) await sleep(100);
  for (const g of groups) if (groupAlive(g)) signalEntry({ pid: g!, group: true, label: "" }, "SIGKILL");
  for (const e of tracked) if (e.group ? groupAlive(e.pid) : alive(e.pid)) signalEntry(e, "SIGKILL");
  for (const fn of cleanups.reverse()) await withTimeout(fn(), 5000);
  rmSync(PID_FILE, { force: true });
  if (announce) process.stdout.write(`${c.dim("已关闭：server、web、sandbox 都已退出。")}\n`);
  process.exit(code);
}

export function installSignalHandlers() {
  let count = 0;
  const handler = (sig: string) => {
    // A repeated signal while shutting down is ignored (cleanup is bounded to ~10s);
    // a third Ctrl-C forces exit — the watchdog still cleans up after us.
    if (shuttingDown) {
      if (++count >= 2) {
        process.stderr.write("\n强制退出（watchdog 会清理剩下的进程）\n");
        process.exit(130);
      }
      return;
    }
    process.stdout.write(`\n${c.dim(`收到 ${sig}，正在关闭所有子进程和 sandbox…`)}\n`);
    // A requested stop is a normal end of the demo: exit 0 so pnpm does not print "Command failed".
    void shutdown(0, true);
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGHUP", () => handler("SIGHUP"));
}

/**
 * Poll until http://<host>:<port><path> answers (any status < 500) on ANY of
 * localhost / 127.0.0.1 / [::1] — vite binds only ::1 on some systems.
 */
export async function waitForHttp(port: number, path: string, timeoutMs: number, isAlive?: () => boolean): Promise<string | undefined> {
  const hosts = ["localhost", "127.0.0.1", "[::1]"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) return undefined;
    const hit = await Promise.any(
      hosts.map(async (h) => {
        const url = `http://${h}:${port}${path}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        await res.body?.cancel();
        if (res.status >= 500) throw new Error(String(res.status));
        return url;
      }),
    ).catch(() => undefined);
    if (hit) return hit;
    await sleep(500);
  }
  return undefined;
}

/** True if something accepts connections on localhost:port (IPv4 or IPv6 — vite binds ::1 only). */
export async function portInUse(port: number): Promise<boolean> {
  const net = await import("node:net");
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(1000, () => done(false));
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
  const [v4, v6] = await Promise.all([probe("127.0.0.1"), probe("::1")]);
  return v4 || v6;
}
