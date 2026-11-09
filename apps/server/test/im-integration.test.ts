import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dataPath } from "@baitnet/agent";
import { getPlaybookVersion, listCorrections } from "@baitnet/training";
import { FakeTelegram, type FakeUser, type SentMessage } from "../../../packages/im/test/fake-telegram.js";
import { createApp, type App } from "../src/app.js";

const EXPERT: FakeUser = { id: 1001, first_name: "阿明", username: "aming", language_code: "zh-hans" };
const REVIEWER: FakeUser = { id: 2002, first_name: "Dylan", username: "dylan", language_code: "zh-hans" };
const ADDRESS = "TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE";

const fake = new FakeTelegram();
let app: App | undefined;
let base = "";

async function boot(): Promise<App> {
  const a = createApp({
    log: () => {},
    attestation: async () => ({ model: "m", nonce: "n", checks: [], verified: true, recorded: true, at: "x" }),
    imOptions: {
      env: { TELEGRAM_BOT_TOKEN: fake.token, BAITNET_IM_DELAY_SCALE: "0", BAITNET_IM_POLL_SEC: "1", BAITNET_IM_MEDIA_GROUP_MS: "150", BAITNET_IM_TICK_MS: "3600000" },
      telegramApiBase: fake.base,
      stateFile: join(dataPath(), "im", "state-telegram.json"),
      random: () => 0.99,
    },
  });
  await a.ready;
  await new Promise<void>((r) => a.listen(0, r));
  base = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
  return a;
}
const close = (a: App) => new Promise<void>((r) => a.close(() => r())).then(() => a.stopIm());

afterAll(async () => {
  if (app) await close(app);
  await fake.close();
});

const btn = (m: SentMessage, match: string) => {
  const b = fake.buttons(m).find((x) => x.text.includes(match));
  if (!b) throw new Error(`no button ${match}: ${JSON.stringify(fake.buttons(m))}`);
  return b.data;
};

describe("server + @baitnet/im（假 Telegram Bot API，真实身份服务和竞技场）", () => {
  it("绑定 → /new 当骗子 → 地址复核上链 → ✏️ 改写通过 → 重启后会话和绑定都在", async () => {
    process.env.BAITNET_REGISTRY = "memory";
    process.env.BAITNET_MODE = "offline";
    await fake.start();
    app = await boot();

    // 1. invites + /start binding (real IdentityStore)
    const rv = app.identity.createInvite("Dylan", "reviewer", "cli", { telegramBot: "baitnet_test_bot" });
    expect(rv.telegramStartUrl).toBe(`https://t.me/baitnet_test_bot?start=${rv.code}`);
    fake.say(REVIEWER, `/start ${rv.code}`);
    await fake.waitFor(REVIEWER.id, (m) => m.text.includes("绑定成功"));
    const ex = app.identity.createInvite("阿明", "expert", "Dylan");
    fake.say(EXPERT, `/start ${ex.code}`);
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("绑定成功"));
    expect((await app.identity.userByBinding("telegram", String(EXPERT.id)))!.id).toBe(ex.userId);
    expect((await app.identity.reviewers("telegram")).map((r) => r.externalId)).toEqual([String(REVIEWER.id)]);

    // 2. /new → I play the scammer → investment script
    let from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "/new");
    const pick = await fake.waitFor(EXPERT.id, (m) => m.text.includes("你想扮哪一方"), 8000, from);
    fake.press(EXPERT, pick.message_id, "n:s");
    await fake.waitFor(EXPERT.id, (m) => m.message_id === pick.message_id && m.text.includes("骗局类型"));
    fake.press(EXPERT, pick.message_id, "n:s:investment");
    const list = await fake.waitFor(EXPERT.id, (m) => m.message_id === pick.message_id && m.text.includes("选剧本"));
    fake.press(EXPERT, pick.message_id, fake.buttons(list)[0]!.data);
    await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("开始！"), 8000, from);
    const sid = (await app.identity.chats.get("telegram", String(EXPERT.id)))!;
    expect(app.arena.get(sid)!.session.channel).toMatchObject({ kind: "telegram", chatId: String(EXPERT.id), ownerId: ex.userId, expertPlays: "scammer" });

    // 3. scammer line with an address → reviewer card → ✅ → on chain (/check blocks)
    fake.say(EXPERT, `VIP 通道充值地址：${ADDRESS}（TRC20），充完截图给我`);
    const card = await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待复核地址") && m.text.includes(ADDRESS));
    const cb = fake.press(REVIEWER, card.message_id, btn(card, "上链"));
    expect((await fake.waitAnswer(cb)).text).toMatch(/已上链 #\d+/);
    const check = await (await fetch(`${base}/check?chain=tron&address=${ADDRESS}`)).json();
    expect(check.kind).toBe("block");
    expect(app.arena.get(sid)!.session.drafts[0]).toMatchObject({ review: "approved", txHash: expect.any(String) });

    // 4. ✏️ correction → reviewer approves → playbook version +1
    const v0 = getPlaybookVersion();
    from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "我们群里每天都有人晒收益，你先进群看看");
    const bait = await fake.waitFor(EXPERT.id, (m) => fake.buttons(m).some((b) => b.text === "✏️"), 8000, from);
    from = fake.sentTo(EXPERT.id).length;
    fake.press(EXPERT, bait.message_id, btn(bait, "✏️"));
    const prompt = await fake.waitFor(EXPERT.id, (m) => m.text === "请回复更好的说法", 8000, from);
    fake.say(EXPERT, "群我先不进了，你们平台的充值地址是哪个？我先小额试一下", { reply_to_message: { message_id: prompt.message_id } });
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已生成改写"));
    const c = listCorrections({ review: "pending" }).find((x) => x.sessionId === sid)!;
    expect(c.expertId).toBe(ex.userId);
    const rcard = await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待审改写") && m.text.includes("小额试一下"));
    fake.press(REVIEWER, rcard.message_id, btn(rcard, "通过"));
    await fake.waitFor(REVIEWER.id, (m) => m.message_id === rcard.message_id && m.text.includes("已通过"));
    expect(getPlaybookVersion()).toBe(v0 + 1);
    expect(app.identity.listAudit({ expertId: ex.userId }).some((a) => a.action === "training.correction")).toBe(true);

    // 5. restart: bindings, chat→session map and the session itself survive
    await fake.settle();
    await close(app);
    app = await boot();
    expect((await app.identity.userByBinding("telegram", String(EXPERT.id)))!.id).toBe(ex.userId);
    expect(await app.identity.chats.get("telegram", String(EXPERT.id))).toBe(sid);
    const restored = app.arena.get(sid)!;
    expect(restored.session.status).toBe("paused");
    expect(restored.session.channel?.kind).toBe("telegram");
    const n = restored.session.turns.length;
    from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "还在吗？今天名额快满了");
    await fake.waitFor(EXPERT.id, (m) => fake.buttons(m).some((b) => b.text === "✏️"), 8000, from);
    expect(app.arena.get(sid)!.session.turns.length).toBeGreaterThan(n);
    expect((await app.identity.quota(ex.userId)).limitPerDay).toBe(300);
  }, 60_000);
});
