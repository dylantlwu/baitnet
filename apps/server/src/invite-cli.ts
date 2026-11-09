/** pnpm --filter @baitnet/server run invite -- --name Dylan --role reviewer */
import type { Role } from "@baitnet/shared";
import { dataPath } from "@baitnet/agent";
import { IdentityStore, telegramBotUsername } from "./auth.js";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const name = arg("name");
const role = (arg("role") ?? "expert") as Role;
if (!name || (role !== "expert" && role !== "reviewer")) {
  console.error("usage: pnpm --filter @baitnet/server run invite -- --name <名字> [--role expert|reviewer]");
  process.exit(1);
}
const ids = new IdentityStore(dataPath("auth.sqlite"));
const inv = ids.createInvite(name, role, "cli", { publicUrl: process.env.BAITNET_PUBLIC_URL, telegramBot: await telegramBotUsername() });
await ids.audit({ expertId: "cli", action: "admin.invites", target: inv.userId, detail: JSON.stringify({ name, role }) });
console.log(`邀请码 invite code (只显示这一次 shown once): ${inv.code}`);
console.log(`用户 user: ${inv.name} (${inv.role}, ${inv.userId})`);
console.log(`网页登录 loginUrl: ${inv.loginUrl ?? "(set BAITNET_PUBLIC_URL to get a link)"}`);
console.log(`Telegram: ${inv.telegramStartUrl ?? "(set TELEGRAM_BOT_USERNAME or TELEGRAM_BOT_TOKEN to get a link)"}`);
ids.close();
