/**
 * Create a login invite (D20) from the command line — this is how the FIRST reviewer gets in
 * (after that, reviewers create invites in the web admin page).
 *
 *   pnpm invite --name Dylan --role reviewer
 *   (server: sudo baitnet-invite --name 张三 --role expert)
 *
 * Writes to $BAITNET_DATA_DIR/auth.sqlite (default ./data/auth.sqlite) using the server's own
 * AuthStore, prints the code ONCE plus the one-tap login link (BAITNET_PUBLIC_URL).
 * Also: --list (masked), --revoke <code|id>.
 */
import { join } from "node:path";
import { AuthStore } from "../apps/server/src/auth.ts";
import { ROOT, c, errMsg } from "./lib/util.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = join(process.env.BAITNET_DATA_DIR || join(ROOT, "data"), "auth.sqlite");
const publicUrl = process.env.BAITNET_PUBLIC_URL || "http://localhost:8787";

try {
  const store = new AuthStore(dbPath);
  if (args.includes("--list")) {
    for (const i of store.listInvites()) console.log(`${i.id}  ${i.code}  ${i.role.padEnd(8)} ${i.name}  ${i.usedAt ? "已登录" : "未使用"}${i.revoked ? "  已吊销" : ""}`);
  } else if (opt("revoke")) {
    const ok = store.revoke(opt("revoke")!);
    console.log(ok ? "已吊销（该用户的登录立即失效）" : "没找到这个邀请码/ID");
    process.exitCode = ok ? 0 : 1;
  } else {
    const name = opt("name");
    const role = (opt("role") ?? "expert") as "expert" | "reviewer";
    if (!name) throw new Error("用法：--name <名字> [--role expert|reviewer] | --list | --revoke <code|id>");
    const inv = store.createInvite(name, role, "cli", publicUrl);
    console.log(`\n  ${c.bold("邀请已创建")}  ${inv.name}（${inv.role}）`);
    console.log(`  邀请码：${c.bold(inv.code)}   ← 只显示这一次`);
    console.log(`  一点即登链接：${inv.loginUrl}`);
    console.log(c.dim(`  数据库：${dbPath}\n  链接就是凭证：只发给本人（私聊），不要发群、不要用在线二维码生成网站。\n`));
  }
} catch (err) {
  console.error(`invite: ${errMsg(err)}`);
  process.exit(1);
}
