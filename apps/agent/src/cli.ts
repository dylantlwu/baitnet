#!/usr/bin/env tsx
import type { ScamScript } from "@baitnet/shared";
import { RuntimeMissingError } from "./runtime.js";
import { SCRIPTS } from "./bait/bait.js";
import { ReplayProvider, selectProvider } from "./llm/provider.js";
import { demoFlow, fullDemo, makeCtx, stepBait, stepExtractAndReport, stepPaymentAgent, stepResponders, stepSolver, stepTrace } from "./demo.js";
import { redactConversation } from "./extract/extract.js";
import { saveConversation } from "./store.js";

const USAGE = `BaitNet agent CLI
  demo-flow                      P0: replay conversation → report → guard block → GuardEvent
  bait [--script <s>] [--all]    M1 bait conversation (scripts: ${SCRIPTS.join(", ")}); no chain needed
  extract [--script <s>]         M1+M2: bait, extract, seal evidence, report on chain
  pay [--task <file>]            M5: prompt-injected payment agent through guardedSign
  solver                         M6: simulated Intents market maker pre-quote checks
  trace                          M7: trace funds from L1 alerts, report L2 drafts
  responders                     register demo responders + ack alerts
  demo [--replay]                ①–⑥ full demo
Env: BAITNET_REGISTRY=memory (no sandbox), BAITNET_LLM=replay|nearai|claude, NEARAI_API_KEY, ANTHROPIC_API_KEY,
     NEARAI_CLAUDE_MODEL (Claude via NEAR AI when there is no ANTHROPIC_API_KEY; Incognito, not TEE),
     LIVE_INTENTS=1, INTENTS_EXPLORER_JWT, BAITNET_EVIDENCE_KEY, BAITNET_DATA_DIR`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const cmd = process.argv[2];
  const script = (arg("script") ?? "investment") as ScamScript;
  if (!SCRIPTS.includes(script)) throw new Error(`unknown script ${script}`);
  switch (cmd) {
    case "demo-flow":
      await demoFlow();
      break;
    case "bait": {
      // pure M1: no registry required
      const llm = flag("replay") ? new ReplayProvider() : selectProvider();
      const ctx = { log: (l: string) => console.log(l) } as Parameters<typeof stepBait>[0];
      for (const s of flag("all") ? SCRIPTS : [script]) {
        const t0 = Date.now();
        const conv = await stepBait(ctx, s, llm);
        saveConversation(redactConversation(conv));
        const { extractFromConversation } = await import("./extract/extract.js");
        const ex = extractFromConversation(conv);
        console.log(`\n${conv.id}: ${conv.turns.length} turns, ${ex.addresses.length} address(es): ${ex.addresses.map((a) => `${a.chain}:${a.address}`).join(", ")} (${Date.now() - t0} ms)`);
      }
      break;
    }
    case "extract": {
      const ctx = makeCtx();
      for (const s of flag("all") ? SCRIPTS : [script]) await stepExtractAndReport(ctx, await stepBait(ctx, s, flag("replay") ? new ReplayProvider() : selectProvider()));
      break;
    }
    case "pay":
      await stepPaymentAgent(makeCtx(), { taskFile: arg("task") });
      break;
    case "solver":
      await stepSolver(makeCtx());
      break;
    case "trace":
      await stepTrace(makeCtx());
      break;
    case "responders":
      await stepResponders(makeCtx());
      break;
    case "demo":
      await fullDemo(makeCtx(), { llm: flag("replay") ? new ReplayProvider() : undefined });
      break;
    default:
      console.log(USAGE);
      process.exitCode = cmd && cmd !== "help" ? 1 : 0;
  }
}

main().catch((e) => {
  if (e instanceof RuntimeMissingError) console.error(`\n✖ ${e.message}\n`);
  else console.error(`\n✖ ${(e as Error).stack ?? e}`);
  process.exit(1);
});
