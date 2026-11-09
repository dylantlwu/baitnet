import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start, "../../..");
    dir = up;
  }
}

export const REPO_ROOT = process.env.BAITNET_ROOT ?? findRoot(dirname(fileURLToPath(import.meta.url)));
export const FIXTURES_DIR = process.env.BAITNET_FIXTURES_DIR ?? join(REPO_ROOT, "fixtures");

/** Read lazily so tests can point BAITNET_DATA_DIR at a temp dir. */
export function dataDir(): string {
  return process.env.BAITNET_DATA_DIR ?? join(REPO_ROOT, "data");
}
export const dataPath = (...p: string[]) => join(dataDir(), ...p);
export const fixturePath = (...p: string[]) => join(FIXTURES_DIR, ...p);
