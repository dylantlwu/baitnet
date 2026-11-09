import type { ArenaSession } from "@baitnet/shared";
import type { ArenaManager } from "./manager.js";

/** Sessions that show a human takeover of the scammer / a whisper, for the hosted replay. */
export const hasTakeover = (s: ArenaSession) => s.turns.some((t) => t.side === "scammer" && t.author === "human");
export const hasWhisper = (s: ArenaSession) => s.turns.some((t) => !!t.whisper);

/**
 * Record demo sessions (rules engine, deterministic) so the snapshot always has
 * ≥3 replays incl. one scammer takeover and one whisper. Only records what is missing.
 */
export async function ensureDemoSessions(mgr: ArenaManager, opts: { min?: number; log?: (s: string) => void } = {}): Promise<ArenaSession[]> {
  const log = opts.log ?? (() => {});
  const have = mgr.list();
  const made: ArenaSession[] = [];
  const ids = new Set((await mgr.scripts()).map((s) => s.id));
  const pickId = (...c: string[]) => c.find((x) => ids.has(x)) ?? [...ids][0]!;

  if (!have.some(hasTakeover)) {
    // 人接管骗子：AI 开场 → 人以骗子身份给出地址 → 抽取 → 复核上链
    const eng = await mgr.create(pickId("pig-butchering-02", "pig-butchering-01"), { scammer: "ai", bait: "ai" });
    await eng.step();
    await eng.step();
    await eng.say("scammer", "宝，平台充值地址发你：TPx3Yb2mWcN8qRvLs7KdJfH4gTeA9uZ6nE（波场 TRC20），今晚之前转哦");
    eng.setMode("scammer", "ai");
    await eng.step();
    const idx = eng.session.drafts.findIndex((d) => d.review === "pending");
    if (idx >= 0) await eng.review(idx, true, "demo-operator");
    await eng.step();
    await eng.step();
    made.push(eng.session);
    log(`[arena] recorded takeover session ${eng.session.id}`);
  }
  if (!have.some(hasWhisper)) {
    // 耳语：操作员悄悄提示诱饵追问链和备用地址
    const eng = await mgr.create(pickId("investment-01", "investment-03"), { scammer: "ai", bait: "ai" });
    await eng.step();
    eng.whisper("bait", "别急着答应，先问清楚是哪条链、有没有备用地址");
    await eng.step();
    eng.setMode("bait", "ai");
    for (let i = 0; i < 8 && !eng.done; i++) await eng.step();
    made.push(eng.session);
    log(`[arena] recorded whisper session ${eng.session.id}`);
  }
  const total = have.length + made.length;
  for (let i = total; i < (opts.min ?? 3); i++) {
    const eng = await mgr.create(pickId(["task-scam-03", "fake-airdrop-03", "family-emergency-01"][i % 3]!));
    await eng.run();
    await eng.idle();
    made.push(eng.session);
    log(`[arena] recorded AI-vs-AI session ${eng.session.id}`);
  }
  return made;
}
