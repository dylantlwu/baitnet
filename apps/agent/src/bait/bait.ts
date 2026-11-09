import type { Conversation, ScamScript, Turn } from "@baitnet/shared";
import { ReplayProvider, type ChatMessage, type LLMProvider } from "../llm/provider.js";
import { extractFromConversation } from "../extract/extract.js";

export const SCRIPTS: ScamScript[] = ["investment", "pig-butchering", "fake-support"];

/** Fictional, format-valid payment details handed to the simulated scammer (never real addresses). */
const SCRIPT_BRIEFS: Record<ScamScript, { persona: string; payment: string; opener: "scammer" | "bait" }> = {
  investment: {
    persona: "'Amy', account manager at a fake USDT 'quant arbitrage' fund (GoldBridge Capital) promising 2-3% daily returns",
    payment: "NEAR account goldbridge-desk.near (USDT on NEAR), ERC-20 USDT 0x220954f527d61a281b50846419d12a1154c7da46, site https://goldbridge-vip.com, Telegram @GoldBridge_Amy",
    opener: "scammer",
  },
  "pig-butchering": {
    persona: "a friendly romance-scam persona who slowly builds trust then pushes a fake crypto trading platform",
    payment: "USDT-TRC20 address TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB, site https://www.hk-ftxpro.vip, Telegram @lin_yuqing88",
    opener: "scammer",
  },
  "fake-support": {
    persona: "a fake 'NEAR Wallet support agent' who claims the victim's wallet is desynced and needs a verification deposit",
    payment: "NEAR account near-support-escrow.near, BTC bc1q6dscnz3avmlmnj27ykfpl4wdf3dh2wmrjmz26h, site https://nearwallet-support-desk.com/verify",
    opener: "bait",
  },
};

/** Simulated scammer (red-team role-play for an anti-fraud system; never talks to real people). */
export class ScammerSim {
  constructor(
    private llm: LLMProvider,
    readonly script: ScamScript,
  ) {}
  system(): string {
    const b = SCRIPT_BRIEFS[this.script];
    return [
      "You are part of BaitNet, an anti-fraud research system. You play a SIMULATED scammer in a closed test harness;",
      "the other side is an AI decoy, not a real person. Keep it realistic but short (1-3 sentences per message).",
      `Persona: ${b.persona}.`,
      `When the victim asks where to pay, give exactly these fictional details: ${b.payment}.`,
      "Never ask for seed phrases of real people; this is a scripted simulation.",
    ].join(" ");
  }
  reply(history: Turn[], turnIndex: number): Promise<string> {
    return this.llm.complete({ system: this.system(), messages: toMessages(history, "scammer"), replay: { script: this.script, turnIndex } });
  }
}

/** Victim persona: stalls, sounds willing to pay, keeps asking "which address? which chain?". */
export class BaitAgent {
  constructor(
    private llm: LLMProvider,
    readonly script: ScamScript,
  ) {}
  system(): string {
    return [
      "You are an AI decoy in the BaitNet anti-fraud system, playing a hesitant but interested victim talking to a suspected scammer.",
      "Goals: keep them engaged, never send money or real personal data, and get them to state the exact payment address, the chain/network, the token, and any website.",
      "Ask clarifying questions like 'which address exactly?', 'which chain, TRC20 or ERC20?'. Stall politely (busy, bank app slow).",
      "Reply in the same language as the other side, 1-3 sentences.",
    ].join(" ");
  }
  reply(history: Turn[], turnIndex: number): Promise<string> {
    const msgs = toMessages(history, "bait");
    if (!msgs.length) msgs.push({ role: "user", content: "(Start the conversation: reply to a 'customer support' account about a stuck wallet transaction.)" });
    return this.llm.complete({ system: this.system(), messages: msgs, replay: { script: this.script, turnIndex } });
  }
}

/** Map conversation into chat messages from `me`'s perspective (the other side = user). */
function toMessages(history: Turn[], me: Turn["role"]): ChatMessage[] {
  const msgs: ChatMessage[] = history.map((t) => ({ role: t.role === me ? "assistant" : "user", content: t.text }));
  // Anthropic/OpenAI want the first message to be a user turn
  while (msgs.length && msgs[0]!.role === "assistant") msgs.shift();
  if (!msgs.length) msgs.push({ role: "user", content: "(Start the conversation.)" });
  return msgs;
}

export interface BaitOptions {
  maxTurns?: number;
  /** stop once at least this many addresses were extracted (live mode) */
  stopAfterAddresses?: number;
  now?: () => Date;
  log?: (s: string) => void;
}

/**
 * Run one bait conversation. Replay mode reproduces the recorded fixture exactly
 * (same id, turns, timestamps). Live LLM mode falls back to replay on any error.
 */
export async function runBait(llm: LLMProvider, script: ScamScript, opts: BaitOptions = {}): Promise<Conversation> {
  if (llm instanceof ReplayProvider) {
    const f = llm.fixture(script);
    const scammer = new ScammerSim(llm, script);
    const bait = new BaitAgent(llm, script);
    const turns: Turn[] = [];
    for (let i = 0; i < f.turns.length; i++) {
      const role = f.turns[i]!.role;
      const text = role === "scammer" ? await scammer.reply(turns, i) : await bait.reply(turns, i);
      turns.push({ role, text, ts: f.turns[i]!.ts });
    }
    return { id: f.id, script, provider: "replay", turns };
  }
  try {
    return await runLive(llm, script, opts);
  } catch (e) {
    opts.log?.(`[bait] ${llm.name} failed (${(e as Error).message}); falling back to replay`);
    return runBait(new ReplayProvider(), script, opts);
  }
}

async function runLive(llm: LLMProvider, script: ScamScript, opts: BaitOptions): Promise<Conversation> {
  const now = opts.now ?? (() => new Date());
  const scammer = new ScammerSim(llm, script);
  const bait = new BaitAgent(llm, script);
  const turns: Turn[] = [];
  let role: Turn["role"] = SCRIPT_BRIEFS[script].opener;
  const max = opts.maxTurns ?? 14;
  for (let i = 0; i < max; i++) {
    const text = role === "scammer" ? await scammer.reply(turns, i) : await bait.reply(turns, i);
    turns.push({ role, text, ts: now().toISOString() });
    opts.log?.(`[bait] ${role}: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`);
    if (role === "scammer") {
      const n = extractFromConversation({ id: "tmp", script, provider: llm.name, turns }).addresses.length;
      if (n >= (opts.stopAfterAddresses ?? 2) && i >= 5) break;
    }
    role = role === "scammer" ? "bait" : "scammer";
  }
  const id = `conv-${script}-${now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  return { id, script, provider: llm.name, turns };
}
