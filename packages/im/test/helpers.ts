import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaManager } from "@baitnet/arena";
import { MemoryRegistryClient } from "@baitnet/guard";
import type { LLMProvider } from "@baitnet/agent";
import * as training from "@baitnet/training";
import * as scriptlab from "@baitnet/scriptlab";
import { FileChatSessionStore, MemoryIdentityService, scriptlabFromModules, startIm, type ChatSessionStore, type ImHandle } from "../src/index.js";
import { FakeTelegram, type FakeUser, type SentMessage } from "./fake-telegram.js";

export const EXPERT: FakeUser = { id: 1001, first_name: "阿明", username: "aming", language_code: "zh-hans" };
export const REVIEWER: FakeUser = { id: 2002, first_name: "Dylan", username: "dylan", language_code: "zh-hans" };
export const STRANGER: FakeUser = { id: 3003, first_name: "路人", language_code: "zh-hans" };
export const EN_USER: FakeUser = { id: 4004, first_name: "Sam", language_code: "en" };

export const ADDRESS = "TWABPPqD9WBnrrcojkvzJt4WPDNwL6xBz7"; // planted (fictional) address of investment-01

/** Fake LLM: scammer and decoy lines that are easy to recognise. */
export function fakeLLM(): LLMProvider & { calls: number } {
  const llm = {
    name: "claude" as const,
    model: "fake",
    calls: 0,
    async complete(req: { system: string }) {
      llm.calls++;
      return req.system.includes("SIMULATED scammer") ? "我们是正规平台，先充 100U 试试水，收益当天到账。" : "听着不错，那我要往哪个地址转呢？你发我看看。";
    },
  };
  return llm as unknown as LLMProvider & { calls: number };
}

export interface Harness {
  fake: FakeTelegram;
  im: ImHandle;
  identity: MemoryIdentityService;
  arena: ArenaManager;
  registry: MemoryRegistryClient;
  chats: ChatSessionStore;
  stateFile: string;
  logs: string[];
  dir: string;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function harness(opts: { llm?: LLMProvider; limit?: number; bind?: boolean; dir?: string } = {}): Promise<Harness> {
  const fake = new FakeTelegram();
  await fake.start();
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "baitnet-im-h-"));
  const stateFile = join(dir, "state.json");
  const chats = new FileChatSessionStore(join(dir, "chats.json"));
  const identity = new MemoryIdentityService({ llmDailyLimit: opts.limit ?? 300 });
  identity.invite("EXPERT1", "阿明", "expert", "u_expert");
  identity.invite("REVIEW1", "Dylan", "reviewer", "u_rev");
  identity.invite("ENGLISH1", "Sam", "expert", "u_sam");
  const registry = new MemoryRegistryClient({ caller: "im.test" });
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  const mkArena = () => new ArenaManager({ registry, log, llmQuota: (owner) => identity.consumeLlmQuota(owner), ...(opts.llm ? { engine: "claude" as const, llm: opts.llm } : { engine: "rules" as const }) });
  const sl = scriptlabFromModules(scriptlab, {
    // screenshots: "live" mode with a fake vision model; analysis itself stays on the rules engine
    analyze: {
      env: { BAITNET_MODE: "live", ANTHROPIC_API_KEY: "test", BAITNET_LLM: "replay" },
      vision: async () => `客服小王：您好，您的账户异常需要验证\n我：怎么验证？\n客服小王：把 USDT 转到安全账户 ${ADDRESS} 就行，手机 13812345678 联系我`,
    },
    registry,
    log,
  });
  const h: Harness = {
    fake,
    identity,
    registry,
    chats,
    stateFile,
    logs,
    dir,
    arena: mkArena(),
    im: undefined as unknown as ImHandle,
    async restart() {
      await h.im.stop();
      h.arena = mkArena();
      h.im = await boot();
    },
    async close() {
      await h.im.stop();
      await fake.close();
    },
  };
  const boot = () =>
    startIm({
      identity,
      chats,
      arena: h.arena,
      training,
      scriptlab: sl,
      publicUrl: "https://baitnet.test",
      env: { TELEGRAM_BOT_TOKEN: fake.token, BAITNET_IM_DELAY_SCALE: "0", BAITNET_IM_POLL_SEC: "1", BAITNET_IM_MEDIA_GROUP_MS: "150", BAITNET_IM_TICK_MS: "3600000" },
      telegramApiBase: fake.base,
      stateFile,
      log,
      random: () => 0.99, // no message splitting, "random" script = last
    });
  h.im = await boot();
  if (opts.bind !== false) {
    for (const [u, code] of [
      [EXPERT, "EXPERT1"],
      [REVIEWER, "REVIEW1"],
    ] as const) {
      fake.say(u, `/start ${code}`);
      await fake.waitFor(u.id, (m) => m.text.includes("绑定成功"));
    }
  }
  return h;
}

export function btn(fake: FakeTelegram, m: SentMessage, match: string | RegExp) {
  const b = fake.buttons(m).find((x) => (typeof match === "string" ? x.text.includes(match) || x.data === match : match.test(x.text) || match.test(x.data)));
  if (!b) throw new Error(`no button ${match} on #${m.message_id}: ${JSON.stringify(fake.buttons(m))}`);
  return b.data;
}

/** Run the /new wizard. side: "骗子" | "诱饵". */
export async function newSession(h: Harness, user: FakeUser, side: "scammer" | "bait", scriptTitle = "AI 量化套利", type = "investment") {
  const { fake } = h;
  const from = fake.sentTo(user.id).length;
  fake.say(user, "/new");
  const pick = await fake.waitFor(user.id, (m) => m.text.includes("你想扮哪一方"), 8000, from);
  fake.press(user, pick.message_id, side === "scammer" ? "n:s" : "n:b");
  await fake.waitFor(user.id, (m) => m.message_id === pick.message_id && m.text.includes("骗局类型"));
  fake.press(user, pick.message_id, `n:${side === "scammer" ? "s" : "b"}:${type}`);
  const list = await fake.waitFor(user.id, (m) => m.message_id === pick.message_id && m.text.includes("选剧本"));
  fake.press(user, pick.message_id, btn(fake, list, scriptTitle));
  await fake.waitFor(user.id, (m) => m.text.startsWith("开始！"), 8000, from);
  const sid = await h.chats.get("telegram", String(user.id));
  return sid!;
}

export const readState = (h: Harness) => JSON.parse(readFileSync(h.stateFile, "utf8"));
