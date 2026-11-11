import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getCorrection, listAnnotations, listCorrections } from "@baitnet/training";
import { ADDRESS, EN_USER, EXPERT, REVIEWER, STRANGER, btn, fakeLLM, harness, newSession, readState, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const lastBaitMsg = (hh: Harness, chat: number, from = 0) => hh.fake.waitFor(chat, (m) => hh.fake.buttons(m).some((b) => b.data.startsWith("e:")), 8000, from);

describe("IM 训练台 · Telegram 端到端（假 Bot API）", () => {
  it("白名单：未绑定的人只收到一次提示，按钮和群消息一律不理；邀请码错误有提示", async () => {
    h = await harness({ bind: false });
    const { fake } = h;
    fake.say(STRANGER, "你好，在吗？");
    await fake.waitFor(STRANGER.id, (m) => m.text.includes("请先用邀请码绑定"));
    fake.say(STRANGER, "转账给我");
    fake.say(STRANGER, "/new");
    fake.sayInGroup(STRANGER, "/start EXPERT1");
    await fake.settle();
    expect(fake.sentTo(STRANGER.id)).toHaveLength(1);
    expect(fake.sentTo(-100123)).toHaveLength(0);
    // a forged button press from a stranger: acknowledged silently, nothing else
    fake.messages.set(1, { message_id: 1, chat_id: String(STRANGER.id), text: "x", edits: 0 });
    const cb = fake.press(STRANGER, 1, "cr:cor_x:1");
    expect((await fake.waitAnswer(cb)).text).toBeUndefined();
    fake.say(STRANGER, "/start WRONGCODE");
    await fake.waitFor(STRANGER.id, (m) => m.text.includes("邀请码无效"));
    expect(await h.identity.userByBinding("telegram", String(STRANGER.id))).toBeNull();
  });

  it("/start 绑定（含 deep link 的 start 参数），命令菜单中英两套", async () => {
    h = await harness({ bind: false });
    const { fake } = h;
    fake.say(EXPERT, "/start EXPERT1");
    const w = await fake.waitFor(EXPERT.id, (m) => m.text.includes("绑定成功"));
    expect(w.text).toContain("阿明");
    expect((await h.identity.userByBinding("telegram", String(EXPERT.id)))?.id).toBe("u_expert");
    expect(h.identity.auditLog.some((a) => a.action === "im.bind" && a.expertId === "u_expert")).toBe(true);
    await fake.settle();
    const zh = fake.commands.find((c) => !c.lang)!;
    const en = fake.commands.find((c) => c.lang === "en")!;
    expect(zh.commands.map((c) => c.command)).toEqual(expect.arrayContaining(["new", "w", "mode", "end", "status", "help", "start"]));
    expect(zh.commands.find((c) => c.command === "new")!.description).toMatch(/开一场/);
    expect(en.commands.find((c) => c.command === "new")!.description).toMatch(/Start/);
    fake.say(EXPERT, "/start");
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已经绑定过了"));
  });

  it("/new 我当骗子：机器人是诱饵小林，回复带 👍👎✏️；👍 记成 Annotation", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    const s = h.arena.get(sid)!.session;
    expect(s.channel).toMatchObject({ kind: "telegram", chatId: String(EXPERT.id), ownerId: "u_expert", expertPlays: "scammer" });
    expect(s.modes).toEqual({ scammer: "human", bait: "ai" });
    const from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "你好，我是量子星辰资本的陈老师，带你做 AI 量化套利，日化 2%。");
    const bait = await lastBaitMsg(h, EXPERT.id, from);
    expect(fake.buttons(bait).map((b) => b.text)).toEqual(["👍", "👎", "✏️"]);
    expect(s.turns.map((t) => t.side)).toEqual(["scammer", "bait"]);
    expect(s.turns[0]!.author).toBe("human");
    expect(fake.calls.some((c) => c.method === "sendChatAction")).toBe(true);
    const cb = fake.press(EXPERT, bait.message_id, btn(fake, bait, "👍"));
    expect((await fake.waitAnswer(cb)).text).toContain("👍");
    const anns = listAnnotations({ sessionId: sid });
    expect(anns).toHaveLength(1);
    expect(anns[0]).toMatchObject({ turnIndex: 1, rating: "good", expertId: "u_expert" });
  });

  it("/new 我当诱饵：骗子 AI 先开口并交代人设；专家的话后面有 ⭐，点了生成 goodReply 候选", async () => {
    h = await harness();
    const { fake } = h;
    const before = fake.sentTo(EXPERT.id).length;
    const sid = await newSession(h, EXPERT, "bait");
    const opener = await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("（我是："), 8000, before);
    expect(opener.text).toContain("陈博文");
    const eng = h.arena.get(sid)!;
    expect(eng.session.turns[0]).toMatchObject({ side: "scammer", author: "ai" });
    const from = fake.sentTo(EXPERT.id).length;
    const myMsg = fake.say(EXPERT, "日化 2% 这么高？你们平台叫什么，充值地址发我看看");
    const star = await fake.waitFor(EXPERT.id, (m) => fake.buttons(m).some((b) => b.data.startsWith("st:")), 8000, from);
    expect(star.reply_to).toBe(myMsg);
    await fake.waitFor(EXPERT.id, (m) => m.message_id > star.message_id && !m.text.startsWith("·"), 8000, from); // scammer answers
    const cb = fake.press(EXPERT, star.message_id, btn(fake, star, /^st:/));
    expect((await fake.waitAnswer(cb)).text).toContain("⭐");
    const c = listCorrections({ review: "pending" }).find((x) => x.sessionId === sid)!;
    expect(c).toMatchObject({ turnIndex: 1, expertId: "u_expert", goodReply: "日化 2% 这么高？你们平台叫什么，充值地址发我看看", scriptId: "investment-01", review: "pending" });
    expect(c.badReply).toBe("");
    expect(c.situation.split("\n")[0]).toBe(eng.session.turns[0]!.text.split("\n")[0]); // (handles are redacted on write)
    expect(c.tags).toContain("expert-demo");
    // reviewer gets a ⭐ card
    await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待审好话术") && m.text.includes("充值地址发我看看"));
  });

  it("✏️ 改写 → pending Correction → reviewer 卡片；expert 点审核按钮被拒，reviewer 通过后进入话术库", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    let from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "我们群里每天都有人晒收益，你先进群看看");
    const bait = await lastBaitMsg(h, EXPERT.id, from);
    from = fake.sentTo(EXPERT.id).length;
    fake.press(EXPERT, bait.message_id, btn(fake, bait, "✏️"));
    const prompt = await fake.waitFor(EXPERT.id, (m) => m.text === "请回复更好的说法", 8000, from);
    expect(prompt.reply_markup?.force_reply).toBe(true);
    fake.say(EXPERT, "群我先不进了，你们平台的充值地址是哪个？我先小额试一下", { reply_to_message: { message_id: prompt.message_id } });
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已生成改写"));
    const c = listCorrections({ review: "pending" }).find((x) => x.sessionId === sid)!;
    expect(c).toMatchObject({ turnIndex: 1, expertId: "u_expert", scamType: "investment", situation: "我们群里每天都有人晒收益，你先进群看看" });
    expect(c.badReply).toBe(h.arena.get(sid)!.session.turns[1]!.text);
    expect(h.identity.auditLog.some((a) => a.action === "training.correction" && a.target === c.id)).toBe(true);

    const card = await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待审改写") && m.text.includes("小额试一下"));
    // the expert forges a press on the reviewer's card → refused
    const cbExpert = fake.press(EXPERT, card.message_id, `cr:${c.id}:1`);
    expect((await fake.waitAnswer(cbExpert)).text).toBe("等审核者处理");
    expect(getCorrection(c.id)!.review).toBe("pending");
    expect(h.identity.auditLog.some((a) => a.action === "im.denied" && a.expertId === "u_expert")).toBe(true);

    fake.press(REVIEWER, card.message_id, btn(fake, card, "通过"));
    await fake.waitFor(REVIEWER.id, (m) => m.message_id === card.message_id && m.text.includes("已通过"));
    expect(getCorrection(c.id)).toMatchObject({ review: "approved", reviewer: "u_rev" });
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("你的改写已通过"));
  });

  it("耳语 /w 只给本场 AI，下一句生效", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    fake.say(EXPERT, "/w 别急着转钱，先问清楚充值地址");
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已耳语给诱饵「小林」"));
    const from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "名额有限，今天不充就没了");
    await lastBaitMsg(h, EXPERT.id, from);
    const bait = h.arena.get(sid)!.session.turns.filter((t) => t.side === "bait").at(-1)!;
    expect(bait.whisper).toBe("别急着转钱，先问清楚充值地址");
    fake.say(EXPERT, "/w");
    await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("用法：/w"));
  });

  it("抽到地址：专家收到“已记录，等审核”；expert 越权被拒；reviewer ✅ 上链写进内存登记表", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    fake.say(EXPERT, `VIP 通道充值地址：${ADDRESS}（TRC20），充完截图给我`);
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已记录，等审核") && m.text.includes(ADDRESS));
    const card = await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待复核地址") && m.text.includes(ADDRESS));
    expect(fake.buttons(card).map((b) => b.text)).toEqual(["✅ 上链", "❌ 驳回"]);

    const denied = fake.press(EXPERT, card.message_id, btn(fake, card, "上链"));
    expect((await fake.waitAnswer(denied)).text).toBe("等审核者处理");
    expect(h.arena.get(sid)!.session.drafts[0]!.review).toBe("pending");

    const cb = fake.press(REVIEWER, card.message_id, btn(fake, card, "上链"));
    expect((await fake.waitAnswer(cb)).text).toMatch(/已上链 #\d+/);
    const d = h.arena.get(sid)!.session.drafts[0]!;
    expect(d.review).toBe("approved");
    const alert = await h.registry.getAlert(d.alertId!);
    expect(alert?.address).toBe(ADDRESS);
    await fake.waitFor(REVIEWER.id, (m) => m.message_id === card.message_id && m.text.includes("已上链"));
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已上链") && m.text.includes(`#${d.alertId}`));
    // a second press is harmless
    const again = fake.press(REVIEWER, card.message_id, `d:${sid}:0:1`);
    expect((await fake.waitAnswer(again)).text).toBe("已经处理过了");
  });

  it("D33：挂了防混淆警告的地址，卡片只有驳回按钮并列出警告；硬按上链会被拒绝并提示去网页后台", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    const from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "等一下，你回得这么快，你是不是机器人？");
    await lastBaitMsg(h, EXPERT.id, from);
    fake.say(EXPERT, `VIP 通道充值地址：${ADDRESS}（TRC20），充完截图给我`);
    const card = await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待复核地址") && m.text.includes(ADDRESS));
    expect(card.text).toMatch(/防混淆警告（1 条）/);
    expect(card.text).toMatch(/机器人/);
    expect(fake.buttons(card).map((b) => b.text)).toEqual(["❌ 驳回"]);
    const forced = fake.press(REVIEWER, card.message_id, `d:${sid}:0:1`);
    expect((await fake.waitAnswer(forced)).text).toMatch(/网页后台逐条核实/);
    expect(h.arena.get(sid)!.session.drafts[0]!.review).toBe("pending");
  });

  it("上传：截图 media group 合并成一次上传，先发隐私提醒（每天只一次），回分析摘要，可存为剧本", async () => {
    h = await harness();
    const { fake } = h;
    const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, n)]);
    fake.photos(EXPERT, [jpeg(1), jpeg(2), jpeg(3)], "album1");
    const privacy = await fake.waitFor(EXPERT.id, (m) => m.text.includes("上传前提醒"));
    expect(privacy.text).toContain("Telegram 的服务器");
    fake.press(EXPERT, privacy.message_id, btn(fake, privacy, "继续分析"));
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("收到 3 张截图"));
    const card = await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("📄 分析摘要"), 15000);
    expect(card.text).toMatch(/类型：.+（置信度 \d+%）/);
    expect(card.text).toContain(ADDRESS);
    expect(card.text).toMatch(/打码：[1-9]\d* 处/);
    expect(card.text).toContain("等审核");
    // only one getFile per photo, all three in one analysis
    expect(fake.calls.filter((c) => c.method === "getFile")).toHaveLength(3);
    expect(fake.sentTo(EXPERT.id).filter((m) => m.text.startsWith("📄"))).toHaveLength(1);
    await fake.waitFor(REVIEWER.id, (m) => m.text.includes("待复核地址（上传）") && m.text.includes(ADDRESS));

    fake.press(EXPERT, card.message_id, btn(fake, card, "存为剧本"));
    await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("已存为剧本"));
    expect((await h.arena.scripts()).some((s) => s.id.startsWith("upload-"))).toBe(true);

    // second upload the same day: no reminder again
    fake.document(EXPERT, "chat.txt", Buffer.from(`骗子：你好，投资 USDT 稳赚，充值地址 ${ADDRESS}\n我：真的吗\n骗子：今天就能提现`, "utf8"));
    await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("📄 分析摘要") && m.message_id > card.message_id, 15000);
    expect(fake.sentTo(EXPERT.id).filter((m) => m.text.includes("上传前提醒"))).toHaveLength(1);
    expect(h.identity.auditLog.filter((a) => a.action === "scripts.upload" && a.expertId === "u_expert")).toHaveLength(2);
  });

  it("额度用完：会话自动降级成规则模式，并告诉专家（只说一次）", async () => {
    const llm = fakeLLM();
    h = await harness({ llm, limit: 1 });
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    expect(h.arena.get(sid)!.session.engine).toBe("claude");
    let from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "你好，带你赚钱");
    await lastBaitMsg(h, EXPERT.id, from);
    expect(llm.calls).toBe(1);
    from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "日化 2%，稳赚");
    await fake.waitFor(EXPERT.id, (m) => m.text === "今日大模型额度已用完，已切换到规则模式。", 8000, from);
    await lastBaitMsg(h, EXPERT.id, from);
    expect(h.arena.get(sid)!.session.engine).toBe("rules");
    expect(llm.calls).toBe(1);
    from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "再不充就没名额了");
    await lastBaitMsg(h, EXPERT.id, from);
    expect(fake.sentTo(EXPERT.id).filter((m) => m.text.includes("额度已用完"))).toHaveLength(1);
  });

  it("D30 /new 选模型：有大模型时多一步（四个按钮 + 跳过，默认 DeepSeek 打勾），选 GLM 记进会话；跳过 = 默认；无大模型时不出现这一步", async () => {
    const llm = fakeLLM();
    h = await harness({ llm });
    const { fake } = h;
    const from = fake.sentTo(EXPERT.id).length;
    const sid = await newSession(h, EXPERT, "scammer", "AI 量化套利", "investment", "glm");
    const card = fake.sentTo(EXPERT.id).slice(from).find((m) => m.text.includes("AI 量化套利") && m.text.includes("🤖"))!;
    expect(card.text).toContain("🤖 fake"); // injected test LLM's model id is shown as-is
    expect(h.arena.get(sid)!.session.modelChoice).toBe("glm");
    expect(h.arena.get(sid)!.session.model).toBe("fake");
    // second user: the wizard buttons, random + skip
    const f2 = fake.sentTo(REVIEWER.id).length;
    fake.say(REVIEWER, "/new");
    const pick = await fake.waitFor(REVIEWER.id, (m) => m.text.includes("你想扮哪一方"), 8000, f2);
    fake.press(REVIEWER, pick.message_id, "n:b");
    await fake.waitFor(REVIEWER.id, (m) => m.message_id === pick.message_id && m.text.includes("骗局类型"));
    fake.press(REVIEWER, pick.message_id, "n:b:investment");
    await fake.waitFor(REVIEWER.id, (m) => m.message_id === pick.message_id && m.text.includes("选剧本"));
    fake.press(REVIEWER, pick.message_id, "n:b:investment:*");
    const mp = await fake.waitFor(REVIEWER.id, (m) => m.message_id === pick.message_id && m.text.includes("选 AI 用的模型"));
    const bs = fake.buttons(mp);
    expect(bs.map((b) => b.data.split(":").pop())).toEqual(["deepseek", "glm", "haiku", "sonnet", "-"]);
    expect(bs[0]!.text).toMatch(/^✅ DeepSeek V4\.1 Flash · TEE · 便宜/);
    expect(bs[3]!.text).toContain("非 TEE · 较贵");
    expect(bs.every((b) => !b.data.includes("*"))).toBe(true); // random resolved before the model step
    fake.press(REVIEWER, pick.message_id, bs[4]!.data); // skip → default
    await fake.waitFor(REVIEWER.id, (m) => m.text.startsWith("开始！"), 8000, f2);
    const sid2 = await h.chats.get("telegram", String(REVIEWER.id));
    expect(h.arena.get(sid2!)!.session.modelChoice).toBe("deepseek");
  });

  it("D30 无大模型（规则模式）时 /new 没有选模型这一步", async () => {
    h = await harness();
    const { fake } = h;
    const from = fake.sentTo(EXPERT.id).length;
    const sid = await newSession(h, EXPERT, "scammer");
    expect(fake.sentTo(EXPERT.id).slice(from).some((m) => m.text.includes("选 AI 用的模型"))).toBe(false);
    expect(h.arena.get(sid)!.session).toMatchObject({ engine: "rules", modelChoice: "deepseek" });
    expect(h.arena.get(sid)!.session.model).toBeUndefined();
  });

  it("服务重启后会话恢复：同一个聊天继续同一场，待回复的 ✏️ 也还在", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    let from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "你好，我是陈老师");
    const bait = await lastBaitMsg(h, EXPERT.id, from);
    fake.press(EXPERT, bait.message_id, btn(fake, bait, "✏️"));
    await fake.waitFor(EXPERT.id, (m) => m.text === "请回复更好的说法");
    const offsetBefore = readState(h).offset;

    await h.restart(); // new ArenaManager, new router, same data dir / state / chat store
    expect(h.arena.get(sid)).toBeUndefined();
    fake.say(EXPERT, "老师好，请问你们公司在哪？");
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("已生成改写"));
    expect(listCorrections({ review: "pending" }).some((c) => c.sessionId === sid && c.goodReply === "老师好，请问你们公司在哪？")).toBe(true);
    from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "公司在新加坡，有牌照");
    await lastBaitMsg(h, EXPERT.id, from);
    expect(await h.chats.get("telegram", String(EXPERT.id))).toBe(sid);
    expect(h.arena.get(sid)!.session.turns.length).toBe(4);
    expect(readState(h).offset).toBeGreaterThan(offsetBefore);
  });

  it("/end 打 1–5 分 + 一句评语；/status；/mode 只看 → 我接管", async () => {
    h = await harness();
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    let from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, `充值地址：${ADDRESS}`);
    await lastBaitMsg(h, EXPERT.id, from);
    fake.say(EXPERT, "/status");
    const st = await fake.waitFor(EXPERT.id, (m) => m.text.includes("今日大模型额度"));
    expect(st.text).toMatch(/今日大模型额度：已用 \d+ \/ 300/);
    expect(st.text).toContain(ADDRESS);
    expect(st.text).toContain("待审");

    fake.say(EXPERT, "/mode");
    const mode = await fake.waitFor(EXPERT.id, (m) => m.text === "选模式：");
    from = fake.sentTo(EXPERT.id).length;
    fake.press(EXPERT, mode.message_id, "md:o");
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("先停一下"), 15000, from); // 6 AI turns, then asks to continue
    expect(h.arena.get(sid)!.session.turns.length).toBeGreaterThanOrEqual(8);
    fake.say(EXPERT, "/mode");
    const mode2 = await fake.waitFor(EXPERT.id, (m) => m.text === "选模式：" && m.message_id !== mode.message_id);
    fake.press(EXPERT, mode2.message_id, "md:h");
    await fake.waitFor(EXPERT.id, (m) => m.message_id === mode2.message_id && m.text.includes("我接管"));
    expect(h.arena.get(sid)!.session.modes.scammer).toBe("human");

    fake.say(EXPERT, "/end");
    const rate = await fake.waitFor(EXPERT.id, (m) => m.text === "给这一场打个分：");
    expect(fake.buttons(rate).map((b) => b.text)).toEqual(["1", "2", "3", "4", "5"]);
    expect(h.arena.get(sid)!.session.status).toBe("finished");
    fake.press(EXPERT, rate.message_id, `rt:${sid}:4`);
    await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("一句评语"));
    fake.say(EXPERT, "诱饵问地址问得太急了");
    await fake.waitFor(EXPERT.id, (m) => m.text.startsWith("已记录 4 分"));
    expect(h.arena.get(sid)!.session.rating).toMatchObject({ expertId: "u_expert", score: 4, note: "诱饵问地址问得太急了" });
    expect(await h.chats.get("telegram", String(EXPERT.id))).toBeUndefined();
    fake.say(EXPERT, "还在吗");
    await fake.waitFor(EXPERT.id, (m) => m.text.includes("没有进行中的对练"));
  });

  it("每天 9 点（上海时间）给 reviewer 推小结，同一天只推一次", async () => {
    h = await harness();
    const r = h.im.router!;
    expect(await r.runDigestIfDue(new Date("2026-11-10T00:30:00Z"))).toBe(false); // 08:30 Shanghai
    expect(await r.runDigestIfDue(new Date("2026-11-10T01:05:00Z"))).toBe(true); // 09:05
    const d = await h.fake.waitFor(REVIEWER.id, (m) => m.text.startsWith("☀️ 每日小结"));
    expect(d.text).toContain("新增改写");
    expect(d.text).toContain("https://baitnet.test/#/training");
    expect(await r.runDigestIfDue(new Date("2026-11-10T02:00:00Z"))).toBe(false);
    expect(h.fake.sentTo(EXPERT.id).some((m) => m.text.includes("每日小结"))).toBe(false);
  });

  it("英文客户端用英文；网络抖动、重复 update 都不影响；token 不出现在日志和状态文件里", async () => {
    h = await harness();
    const { fake } = h;
    fake.failPolls = 2;
    fake.failSends = 1;
    fake.say(EN_USER, "/start ENGLISH1");
    const w = await fake.waitFor(EN_USER.id, (m) => m.text.includes("you're bound"), 15000);
    expect(w.text).toContain("Sam");
    // duplicate delivery of an already handled update id
    fake.pushRaw({ message: { message_id: 9, from: { ...EN_USER, is_bot: false }, chat: { id: EN_USER.id, type: "private" }, date: 0, text: "/help" } }, 1);
    fake.say(EN_USER, "/help");
    await fake.waitFor(EN_USER.id, (m) => m.text.startsWith("🎯 BaitNet training"));
    await fake.settle();
    expect(fake.sentTo(EN_USER.id).filter((m) => m.text.startsWith("🎯"))).toHaveLength(1);
    expect(h.logs.some((l) => /getUpdates failed/.test(l))).toBe(true);
    const token = fake.token;
    expect(h.logs.join("\n")).not.toContain(token.split(":")[1]);
    expect(readFileSync(h.stateFile, "utf8")).not.toContain(token.split(":")[1]);
  });
});

describe("D32 诱饵心智不进 IM 聊天", () => {
  it("模型的 JSON 里只有 reply 发到 Telegram；think / plan / new_facts / 人物卡不出现在聊天里，但记在会话上", async () => {
    const llm = {
      name: "claude" as const,
      model: "fake",
      async complete(req: { system: string }) {
        if (req.system.includes("SIMULATED scammer")) return "我们是正规平台，先充 100U 试试水。";
        return JSON.stringify({ think: "SECRET-THINK 对方在铺垫", scammer_ai: { score: 40, signals: ["模板话术"] }, plan: "SECRET-PLAN 问网址", intel: {}, new_facts: ["SECRET-FACT 我女儿在广州"], reply: "听着不错，那要往哪个地址转？" });
      },
    };
    h = await harness({ llm: llm as never });
    const { fake } = h;
    const sid = await newSession(h, EXPERT, "scammer");
    const from = fake.sentTo(EXPERT.id).length;
    fake.say(EXPERT, "你好，我是量子星辰资本的陈老师，带你做 AI 量化套利。");
    const bait = await lastBaitMsg(h, EXPERT.id, from);
    expect(bait.text).toContain("那要往哪个地址转");
    const all = fake.sentTo(EXPERT.id).map((m) => m.text).join("\n");
    expect(all).not.toMatch(/SECRET-(THINK|PLAN|FACT)|scammer_ai|"reply"/);
    const s = h.arena.get(sid)!.session;
    expect(all).not.toContain(s.persona!.background);
    expect(s.turns.at(-1)!.mind).toMatchObject({ think: "SECRET-THINK 对方在铺垫", plan: "SECRET-PLAN 问网址" });
    expect(s.decoyMind!.facts.map((f) => f.fact)).toContain("SECRET-FACT 我女儿在广州");
  });
});
