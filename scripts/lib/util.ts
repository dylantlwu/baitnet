/**
 * Small helpers shared by scripts/*. No third-party deps on purpose:
 * these must work on a fresh clone right after `pnpm install`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const RUNTIME_JSON = join(DATA_DIR, "runtime.json");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
};

export const log = {
  step: (msg: string) => console.log(`\n${c.bold(c.cyan("▶"))} ${c.bold(msg)}`),
  info: (msg: string) => console.log(`  ${msg}`),
  ok: (msg: string) => console.log(`  ${c.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`  ${c.yellow("!")} ${c.yellow(msg)}`),
  fail: (msg: string) => console.error(`  ${c.red("✗")} ${c.red(msg)}`),
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry with exponential backoff. Used for anything that touches the network. */
export async function retry<T>(
  what: string,
  fn: (attempt: number) => Promise<T>,
  { attempts = 4, baseMs = 2000 }: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts || (err as { bail?: boolean })?.bail) break;
      const wait = Math.min(baseMs * 2 ** (i - 1), 30_000);
      log.warn(`${what} failed (attempt ${i}/${attempts}): ${errMsg(err)} — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.message} (cause: ${errMsg(cause)})` : err.message;
  }
  return String(err);
}

/**
 * Minimal .env loader (KEY=VALUE, # comments, optional quotes).
 * Never overrides variables that are already set in the environment.
 */
export function loadDotEnv(file = join(ROOT, ".env")): boolean {
  if (!existsSync(file)) return false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    // Empty values mean "not set" (keeps .env.example copies harmless).
    if (value !== "" && process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
  return true;
}

/** Is `pnpm --filter <pkg> run <script>` runnable right now? Returns a reason if not. */
export function scriptStatus(pkgDir: string, script: string): { ok: true } | { ok: false; reason: string } {
  const pkgJson = join(ROOT, pkgDir, "package.json");
  if (!existsSync(pkgJson)) return { ok: false, reason: `${pkgDir}/package.json 不存在` };
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { scripts?: Record<string, string> };
  const cmd = pkg.scripts?.[script];
  if (!cmd) return { ok: false, reason: `${pkgDir}/package.json 里没有 "${script}" 脚本` };
  // Common shape: "tsx src/foo.ts ..." — make sure the entry file exists.
  const entry = cmd.match(/^(?:tsx|node|vite-node)\s+(?:watch\s+)?([^\s]+\.(?:ts|js|mjs|cjs))/)?.[1];
  if (entry && !existsSync(join(ROOT, pkgDir, entry))) {
    return { ok: false, reason: `${pkgDir}/${entry} 还不存在（"${script}": ${cmd}）` };
  }
  return { ok: true };
}
