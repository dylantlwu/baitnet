/**
 * Standalone IM runner for local debugging (no apps/server needed):
 *   pnpm --filter @baitnet/im run dev           # real arena engine + in-memory identity
 *   pnpm --filter @baitnet/im run smoke         # only getMe + setMyCommands, then exit
 *
 * Reads TELEGRAM_BOT_TOKEN from the environment or the repo's .env. The token is never printed.
 * Dev invite codes: IM_DEV_INVITES="CODE1:阿明:expert,CODE2:Dylan:reviewer" (else two random codes are generated).
 */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { REPO_ROOT, dataPath } from "@baitnet/agent";
import { ArenaManager, defaultRegistry } from "@baitnet/arena";
import * as training from "@baitnet/training";
import * as scriptlab from "@baitnet/scriptlab";
import type { Role } from "@baitnet/shared";
import { COMMANDS, FileChatSessionStore, MemoryIdentityService, TelegramAdapter, scriptlabFromModules, startIm } from "../src/index.js";

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const smoke = process.argv.includes("--smoke");
const log = (s: string) => console.log(token ? s.split(token).join("<token>") : s);

if (!token) {
  console.log("TELEGRAM_BOT_TOKEN is not set (env or .env) — nothing to do.");
  process.exit(smoke ? 0 : 1);
}

if (smoke) {
  // read-only check against the real Bot API: who am I + command menu; sends no chat messages
  const a = new TelegramAdapter({ token, log });
  const me = await a.me();
  console.log(`getMe ok: @${me.username} (${me.name})`);
  await a.setCommands(COMMANDS.zh);
  await a.setCommands(COMMANDS.en, "en");
  console.log(`setMyCommands ok: ${COMMANDS.zh.map((c) => `/${c.command}`).join(" ")} (zh default + en)`);
  process.exit(0);
}

const identity = new MemoryIdentityService({ llmDailyLimit: Number(process.env.BAITNET_LLM_DAILY_LIMIT ?? 300) });
const invites = (process.env.IM_DEV_INVITES ?? `${randomBytes(4).toString("hex").toUpperCase()}:阿明:expert,${randomBytes(4).toString("hex").toUpperCase()}:Dylan:reviewer`)
  .split(",")
  .map((x) => x.trim().split(":"))
  .filter((x) => x.length === 3);
for (const [code, name, role] of invites) identity.invite(code!, name!, role as Role);

const registry = defaultRegistry();
const arena = new ArenaManager({ log, stepDelayMs: 0, llmQuota: (owner) => identity.consumeLlmQuota(owner) });
await arena.restore().catch((e) => log(`[dev] restore: ${(e as Error).message}`));

const im = await startIm({
  identity,
  chats: new FileChatSessionStore(dataPath("im", "dev-chats.json")),
  arena,
  training,
  scriptlab: scriptlabFromModules(scriptlab, { registry, log }),
  publicUrl: process.env.BAITNET_PUBLIC_URL ?? "http://localhost:5173",
  log,
});
const bot = im.bot?.username;
console.log("\nDev invites (in-memory, lost on exit):");
for (const [code, name, role] of invites) console.log(`  ${name} (${role}): /start ${code}${bot ? `   https://t.me/${bot}?start=${code}` : ""}`);
console.log("Ctrl+C to stop.\n");

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void im.stop().then(() => process.exit(0));
  });
