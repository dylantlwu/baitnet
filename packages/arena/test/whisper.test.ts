import { describe, expect, it } from "vitest";
import type { ArenaEvent } from "@baitnet/shared";
import { ASKS_ADDRESS, RulesBait, firstPerson, foreignTerms, whisperIntents } from "../src/rules.js";
import { rng } from "../src/lang.js";
import { ArenaSessionEngine, defaultRetriever } from "../src/index.js";
import { deps, script, session, SCRIPTS } from "./helpers.js";

const known = [{ chain: "tron", address: "TFjQmhzBQy7aY8bR2CGALRuGq4cR6WjPkt" }];

describe("耳语意图（规则模式）", () => {
  it.each([
    ["问他要一个客服工单号", ["ticket"]],
    ["要个备用链接", ["backupLink"]],
    ["说你要截图留底", ["screenshot"]],
    ["问他是哪条链", ["chain"]],
    ["让他把完整地址发过来", ["fullAddress"]],
    ["先拖一下", ["stall"]],
    ["装糊涂", ["confused"]],
    ["假装心动", ["interested"]],
    ["问他叫什么名字，哪个部门的", ["identity"]],
    ["确认一下金额是多少", ["amount"]],
    ["问他有没有备用地址", ["backupAddress"]],
  ])("中文：%s → %j", (w, intents) => {
    expect(whisperIntents(w)).toEqual(intents);
  });
  it.each([
    ["ask for a ticket number", ["ticket"]],
    ["get a backup link", ["backupLink"]],
    ["ask which network", ["chain"]],
    ["stall a bit", ["stall"]],
    ["ask how much exactly", ["amount"]],
  ])("English: %s → %j", (w, intents) => {
    expect(whisperIntents(w)).toEqual(intents);
  });

  it("多个意图串成一句（中文，已拿到地址）", () => {
    const t = new RulesBait(rng("a")).fromWhisper("问他要一个客服工单号和备用链接，说你要截图留底", "zh", { knownAddresses: known, newAddress: known[0] });
    expect(t).toMatch(/^好的，地址我收到了。/);
    expect(t).toMatch(/工单号|编号/);
    expect(t).toMatch(/备用.{0,3}(链接|网址)/);
    expect(t).toMatch(/截图|留底/);
    expect(t).not.toMatch(ASKS_ADDRESS);
    expect(t).not.toMatch(/[^。！？：…~～]$/);
    // later whispers don't re-acknowledge the same address
    const t2 = new RulesBait(rng("a")).fromWhisper("再拖一下", "zh", { knownAddresses: known });
    expect(t2).not.toMatch(/地址我收到了/);
  });
  it("multiple intents stitched (English)", () => {
    const t = new RulesBait(rng("b")).fromWhisper("ask which network, then stall", "en", { knownAddresses: [] });
    expect(t).toMatch(/network|chain/i);
    expect(t).toMatch(/later|bit|moment|first/i);
  });

  it.each([
    ["问他老家是哪里的", "想问一下，你老家是哪里的？"],
    ["告诉他你下午要开会", "我下午要开会。"],
    ["问问对方要个营业执照", "能不能要个营业执照？"],
    ["跟他说你女儿在旁边看着", "我女儿在旁边看着。"],
  ])("没命中意图 → 第一人称改写：%s", (w, out) => {
    expect(firstPerson(w, "zh")).toBe(out);
  });
  it.each([
    ["ask him where he grew up", "Can I ask where you grew up?"],
    ["tell him you need to check with your bank first", "I need to check with my bank first."],
  ])("first-person rewrite: %s", (w, out) => {
    expect(firstPerson(w, "en")).toBe(out);
  });
});

describe("耳语接入会话", () => {
  it("复现验收会话：exchange-impersonation-01 规则模式，耳语生效且不串戏", async () => {
    const retriever = await defaultRetriever(); // B2 TagRetriever with seed playbook (incl. 承兑 entry)
    const { eng } = session("exchange-impersonation-01", { retriever });
    for (let i = 0; i < 4; i++) await eng.step();
    await eng.say("scammer", "安全仓地址给你了，波场 USDT，T开头那个：TFjQmhzBQy7aY8bR2CG ALRuGq4cR6WjPkt ，十分钟内转过来，不然账户冻结。");
    expect(eng.session.drafts.map((d) => d.address)).toContain("TFjQmhzBQy7aY8bR2CGALRuGq4cR6WjPkt");
    eng.whisper("bait", "问他要一个客服工单号和备用链接，说你要截图留底");
    const b = await eng.step();
    expect(b!.whisper).toBe("问他要一个客服工单号和备用链接，说你要截图留底");
    expect(b!.text).toMatch(/工单号|编号/);
    expect(b!.text).toMatch(/链接|网址/);
    expect(b!.text).toMatch(/截图|留底/);
    expect(b!.text).not.toMatch(/承兑/);
    expect(b!.text).not.toMatch(ASKS_ADDRESS);
  });

  it.each([
    ["zh", "pig-butchering-02", "把助记词告诉他", /seed-phrase/],
    ["zh", "fake-loan-02", "答应转账", /agree-pay/],
    ["zh", "fake-airdrop-01", "点开那个链接", /clicked-link/],
    ["en", "investment-02", "go ahead and pay him", /agree-pay/],
  ])("坏耳语被防护拦下并发 safety 事件（%s %s：%s）", async (_l, id, w, rule) => {
    const { eng } = session(id);
    await eng.step();
    const ev: ArenaEvent[] = [];
    eng.on("event", (e) => ev.push(e));
    eng.whisper("bait", w);
    const b = await eng.step();
    expect(b!.safety?.blocked).toBe(true);
    expect(b!.safety!.rule).toMatch(rule);
    expect(ev.find((e) => e.type === "safety")).toMatchObject({ side: "bait", turnIndex: b!.index });
    expect(b!.text).not.toMatch(/助记词发你|马上转|已经转|点了链接|send it now|I've sent/);
  });
});

describe("模板不串戏 + 拿到地址后不重复追问（全部剧本，含 B2 种子 playbook）", () => {
  it("每个剧本跑完：诱饵回复不含别的类型的专属词；拿到地址后不再要地址", async () => {
    const retriever = await defaultRetriever();
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(30);
    const problems: string[] = [];
    for (const s of SCRIPTS) {
      for (const seed of ["s1", "s2"]) {
        const eng = new ArenaSessionEngine(script(s.id), deps({ retriever }), { id: `${seed}-${s.id}` });
        await eng.run();
        await eng.idle();
        let haveAddr = false;
        for (const t of eng.session.turns) {
          if (t.side === "scammer") {
            if (eng.session.drafts.some((d) => t.text.normalize("NFKC").replace(/\s+/g, "").includes(d.address))) haveAddr = true;
            continue;
          }
          const f = foreignTerms(t.text, s.type);
          if (f.length) problems.push(`${s.id}#${t.index} cross-talk ${f.join(",")}: ${t.text}`);
          // the turn right after the address may confirm it; later turns must not ask for it again
          const prev = eng.session.turns[t.index - 1];
          const justGot = prev && eng.session.drafts.some((d) => prev.text.normalize("NFKC").replace(/\s+/g, "").includes(d.address));
          if (haveAddr && !justGot && ASKS_ADDRESS.test(t.text)) problems.push(`${s.id}#${t.index} re-asks address: ${t.text}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
