import { readFileSync } from "node:fs";
import type { AlertView, Conversation, GuardEvent, ScamScript } from "@baitnet/shared";
import {
  CompositeAccountInfo,
  Guard,
  MemoryHistory,
  NearRpcAccountInfo,
  SampleAccountInfo,
  type AccountInfoProvider,
} from "@baitnet/guard";
import { dataPath, fixturePath } from "./paths.js";
import { allowLiveIntents, networkMode } from "./mode.js";
import { loadEnv, type Env } from "./runtime.js";
import { appendEvent, saveConversation, saveFlows, saveReport, readReports, appendReview, saveAckReceipt } from "./store.js";
import { ReplayProvider, selectProvider, type LLMProvider } from "./llm/provider.js";
import { runBait } from "./bait/bait.js";
import { redactConversation } from "./extract/extract.js";
import {
  AccountAgeCheck,
  KnownEntityFilter,
  loadKnownEntities,
  processConversation,
  reportDrafts,
  type PipelineResult,
  type ReportedDraft,
} from "./extract/pipeline.js";
import { dryRunSigner, guardedSign, planPayments, signLog, vaultSigner, type PaySigner } from "./wallet/wallet.js";
import { handleQuote, liveDryQuote, loadQuoteRequests } from "./solver/solver.js";
import { fetchExplorerTxs, l2Drafts, loadExplorerTxs, traceForward, type ExplorerTx } from "./trace/trace.js";

export type Log = (line: string) => void;
export const consoleLog: Log = (l) => console.log(l);

export interface Ctx {
  env: Env;
  guard: Guard;
  known: KnownEntityFilter;
  samples: SampleAccountInfo;
  accountInfo: AccountInfoProvider;
  log: Log;
}

export function makeCtx(log: Log = consoleLog, env: Env = loadEnv()): Ctx {
  const samples = SampleAccountInfo.fromFile(fixturePath("account-meta.json"));
  const rpc = env.runtime?.rpcUrl;
  const accountInfo = rpc
    ? new CompositeAccountInfo([samples, new NearRpcAccountInfo(rpc, { storePath: dataPath("code-hashes.json") })])
    : samples;
  const guard = new Guard({ registry: env.registry, accountInfo, history: new MemoryHistory(), log: (l) => log(l) });
  return { env, guard, known: new KnownEntityFilter(loadKnownEntities()), samples, accountInfo, log };
}

function header(log: Log, s: string) {
  log("");
  log(`━━━ ${s} ${"━".repeat(Math.max(0, 70 - s.length))}`);
}

export function txLink(env: Env, txHash?: string): string {
  if (!txHash) return "-";
  if (env.network === "testnet") return `https://testnet.nearblocks.io/txns/${txHash}`;
  return txHash;
}

// ① bait ------------------------------------------------------------------------
export async function stepBait(ctx: Ctx, script: ScamScript, llm: LLMProvider = selectProvider()): Promise<Conversation> {
  header(ctx.log, `① Bait conversation (${script}, provider=${llm.name}${llm.model !== "replay" ? `:${llm.model}` : ""}${llm.name === "claude" && llm.via === "nearai" ? " via NEAR AI (Incognito, not TEE)" : ""})`);
  const conv = await runBait(llm, script, { log: ctx.log });
  for (const t of redactConversation(conv).turns) ctx.log(`  ${t.role === "scammer" ? "🎣 scammer" : "🪤 bait   "}: ${t.text}`);
  saveConversation(redactConversation(conv)); // redacted copy only
  return conv;
}

// ② extract + report ------------------------------------------------------------------
export async function stepExtractAndReport(ctx: Ctx, conv: Conversation): Promise<{ pipeline: PipelineResult; reported: ReportedDraft[] }> {
  header(ctx.log, "② Extract → filter → evidence → review → report (M2/M3)");
  const age = new AccountAgeCheck(ctx.samples, { rpcUrl: ctx.env.runtime?.rpcUrl });
  const pipeline = await processConversation(conv, { known: ctx.known, age });
  for (const l of pipeline.log) ctx.log("  " + l);
  for (const d of pipeline.drafts) appendReview({ conversationId: conv.id, chain: d.chain, address: d.address, level: d.level, filteredReason: d.filteredReason ?? null, evidenceHash: d.evidenceHash });
  const logs: string[] = [];
  const reported = await reportDrafts(ctx.env.registry, pipeline.drafts, logs);
  for (const l of logs) ctx.log("  " + l);
  for (const r of reported) {
    ctx.log(`  ↳ tx: ${txLink(ctx.env, r.txHash)}`);
    saveReport({ alertId: r.alertId, chain: r.draft.chain, address: r.draft.address, txHash: r.txHash, evidenceHash: r.draft.evidenceHash, conversationId: conv.id, at: new Date().toISOString() });
  }
  return { pipeline, reported };
}

// ③ prompt-injected payment agent ------------------------------------------------------
export function merchantAccount(env: Env): string {
  const rt = env.runtime;
  return rt?.accounts.responders?.[0]?.accountId ?? rt?.accounts.owner?.accountId ?? "alice-merchant.near";
}

export function paySigner(ctx: Ctx): PaySigner {
  const rt = ctx.env.runtime;
  if (rt?.vaultContract && rt.accounts.agent) return vaultSigner(rt.rpcUrl, rt.vaultContract, rt.accounts.agent);
  return dryRunSigner;
}

export async function stepPaymentAgent(ctx: Ctx, opts: { taskFile?: string; signer?: PaySigner; proveVault?: boolean } = {}): Promise<GuardEvent[]> {
  header(ctx.log, "③ Attack: prompt-injected payment agent → guardedSign (M4/M5)");
  const task = readFileSync(opts.taskFile ?? fixturePath("tasks", "injected-payment.txt"), "utf8").replaceAll("{{MERCHANT}}", merchantAccount(ctx.env));
  const intents = planPayments(task);
  ctx.log(`  [agent] planner produced ${intents.length} payment(s) from task text (${intents.filter((i) => i.injected).length} injected)`);
  const key = ctx.env.runtime?.accounts.agent;
  ctx.log(`  [agent] signing key: ${key ? `${key.accountId} (${key.keyKind ?? "function-call:vault:pay"})` : "none (dry run)"}`);
  await ctx.guard.sync();
  const events: GuardEvent[] = [];
  for (const p of intents) {
    const ev = await guardedSign(p, { guard: ctx.guard, signer: opts.signer ?? paySigner(ctx), emit: appendEvent });
    for (const l of ev.log) ctx.log("  " + l);
    ctx.log(`  → action: ${ev.action.toUpperCase()}`);
    events.push(ev);
  }
  // defense in depth: even if a compromised agent bypassed the off-chain guard,
  // vault.pay calls registry.check on chain and fails (pay_blocked event).
  const rt = ctx.env.runtime;
  const blocked = intents.find((p, i) => p.injected && events[i]?.action === "refused");
  if (opts.proveVault !== false && blocked && rt?.vaultContract && rt.accounts.agent) {
    // small amount so the vault's per-tx limit is not what stops it
    const probe = { ...blocked, amount: "0.1" };
    ctx.log(`  [bypass test] calling vault.pay(${probe.to}, ${probe.amount} NEAR) directly, skipping the guard…`);
    const r = await (opts.signer ?? paySigner(ctx))(probe);
    for (const l of signLog(r)) ctx.log("    " + l);
    const flagged = /PAY_BLOCKED/.test(r.failure ?? "") || (r.events ?? []).some((e: any) => e?.event === "pay_blocked");
    ctx.log(r.failure ? (flagged ? "    → on-chain Vault also refused: registry.check flagged the recipient (PAY_BLOCKED)" : "    → vault.pay failed for another reason (see above)") : "    → WARNING: vault paid a flagged address!");
  }
  return events;
}

// ④ Intents solver ----------------------------------------------------------------------
export async function stepSolver(ctx: Ctx): Promise<GuardEvent[]> {
  header(ctx.log, "④ NEAR Intents market maker: pre-quote guard check (M4/M6)");
  // the solver has its own guard (no per-agent payment history: every recipient would be "new")
  const guard = new Guard({ registry: ctx.env.registry, accountInfo: ctx.accountInfo, log: ctx.log });
  await guard.sync();
  const events: GuardEvent[] = [];
  for (const q of loadQuoteRequests()) {
    const d = await handleQuote(q, guard, { emit: appendEvent });
    for (const l of d.event.log) ctx.log("  " + l);
    events.push(d.event);
  }
  if (process.env.LIVE_INTENTS === "1" && allowLiveIntents()) {
    try {
      const sample = loadQuoteRequests()[0]!.request;
      const live = await liveDryQuote({ ...sample, deadline: new Date(Date.now() + 600_000).toISOString() });
      ctx.log(`  [live] 1Click dry quote OK: ${JSON.stringify(live).slice(0, 300)}`);
    } catch (e) {
      ctx.log(`  [live] 1Click dry quote failed: ${(e as Error).message}`);
    }
  }
  return events;
}

// ⑤ trace -------------------------------------------------------------------------------
export async function stepTrace(ctx: Ctx, alerts?: AlertView[]): Promise<Record<number, ReturnType<typeof traceForward>>> {
  header(ctx.log, "⑤ Fund tracing through Intents 1Click swaps (M7)");
  const jwt = allowLiveIntents() ? process.env.INTENTS_EXPLORER_JWT : undefined;
  if (!jwt) ctx.log(`  [trace] source: fixtures/intents/explorer-transactions.json (${networkMode()} mode${process.env.INTENTS_EXPLORER_JWT ? ", JWT ignored offline" : ", no INTENTS_EXPLORER_JWT"})`);
  const all = alerts ?? (await ctx.env.registry.listAlerts(0, 100));
  const roots = all.filter((a) => a.level === "L1" && a.status === "Active");
  const out: Record<number, ReturnType<typeof traceForward>> = {};
  for (const a of roots) {
    let txs: ExplorerTx[];
    if (jwt) {
      try {
        txs = await fetchExplorerTxs(a.address, jwt);
        ctx.log(`  [trace] live Intents Explorer: ${txs.length} tx for ${a.address}`);
      } catch (e) {
        ctx.log(`  [trace] live API failed (${(e as Error).message}); using sample data`);
        txs = loadExplorerTxs();
      }
    } else txs = loadExplorerTxs();
    const t = traceForward({ chain: a.chain, address: a.address }, txs, { known: ctx.known });
    out[a.id] = t;
    saveFlows(a.id, t.edges);
    if (!t.edges.length) continue;
    ctx.log(`  [trace] alert #${a.id} ${a.chain}:${a.address}`);
    for (const e of t.edges) ctx.log(`    ${e.ts.slice(0, 16)}  ${e.from} ─(${e.protocol}, $${e.amountUsd ?? "?"})→ ${e.chain}:${e.to}`);
    for (const x of t.exits) ctx.log(`    exit → ${x.name} (${x.address}) — shown in graph, not flagged`);
    const { drafts } = l2Drafts(t, a.id, `trace-${a.id}`);
    const logs: string[] = [];
    for (const d of drafts) appendReview({ conversationId: d.conversationId, chain: d.chain, address: d.address, level: "L2", filteredReason: null, evidenceHash: d.evidenceHash });
    const reported = await reportDrafts(ctx.env.registry, drafts, logs);
    for (const l of logs) ctx.log("    " + l);
    for (const r of reported) saveReport({ alertId: r.alertId, chain: r.draft.chain, address: r.draft.address, txHash: r.txHash, evidenceHash: r.draft.evidenceHash, conversationId: r.draft.conversationId, at: new Date().toISOString() });
  }
  return out;
}

// ⑥ responders --------------------------------------------------------------------------
export async function stepResponders(ctx: Ctx): Promise<number> {
  header(ctx.log, "⑥ Voluntary responders sync the registry and ack (M3/M8)");
  const responders =
    ctx.env.runtime?.accounts.responders ??
    (ctx.env.mode === "memory" ? [{ accountId: "demowallet.memory", privateKey: "", name: "DemoWallet" }, { accountId: "demosolver.memory", privateKey: "", name: "DemoSolver" }] : []);
  if (!responders.length) {
    ctx.log("  (no responder accounts in runtime.json — skipped)");
    return 0;
  }
  let n = 0;
  for (const r of responders) {
    // subscriber pulls the public list (no per-address queries leave the subscriber)
    const alerts = await ctx.env.registry.listAlerts(0, 100);
    const receivedAt = new Date().toISOString();
    const reg = ctx.env.registryAs(r);
    if (!(await reg.getResponder(r.accountId))) {
      const tx = await reg.registerResponder(r.name);
      ctx.log(`  [${r.name}] register_responder → tx ${txLink(ctx.env, tx.txHash)}`);
    }
    // a subscriber matches locally against its own customer flow; demo: it blocks every L1 it sees
    for (const a of alerts.filter((x) => x.status === "Active")) {
      const outcome = a.level === "L1" ? "Blocked" : "Seen";
      saveAckReceipt({ alertId: a.id, responder: r.accountId, receivedAt });
      await reg.ack(a.id, outcome);
      n++;
      ctx.log(`  [${r.name}] ack alert #${a.id} (${a.chain}:${a.address}) → ${outcome}`);
    }
  }
  return n;
}

// P0 minimal flow -----------------------------------------------------------------------
/** P0: hard-coded replay conversation → extract → report → guard block → GuardEvent. */
export async function demoFlow(ctx: Ctx = makeCtx()): Promise<{ alertIds: number[]; event: GuardEvent }> {
  ctx.log(`BaitNet demo-flow (registry: ${ctx.env.mode === "chain" ? `${ctx.env.registry.contractId} on ${ctx.env.network}` : "in-memory"})`);
  const conv = await stepBait(ctx, "investment", new ReplayProvider());
  const { reported } = await stepExtractAndReport(ctx, conv);
  if (!reported.length) throw new Error("demo-flow: nothing was reported");
  header(ctx.log, "Guard check");
  await ctx.guard.sync();
  const target = reported[0]!.draft;
  const ev = await guardedSign(
    { to: target.address, amount: "50", asset: "USDC", source: "demo-flow: hard-coded payment to the extracted address", injected: true },
    { guard: ctx.guard, signer: dryRunSigner, emit: appendEvent },
  );
  // non-NEAR targets: guardedSign checks chain=near; fall back to a direct check for the log
  const v = target.chain === "near" ? ev.verdict : await ctx.guard.check(target);
  for (const l of ev.log) ctx.log("  " + l);
  ctx.log(`  guard verdict for ${target.chain}:${target.address} = ${v.kind.toUpperCase()}`);
  if (v.kind !== "block") throw new Error(`demo-flow: expected block, got ${v.kind}`);
  return { alertIds: reported.map((r) => r.alertId), event: ev };
}

/** Full ①–⑥ demo script (docs §1). */
export async function fullDemo(ctx: Ctx = makeCtx(), opts: { scripts?: ScamScript[]; llm?: LLMProvider } = {}) {
  const llm = opts.llm ?? selectProvider();
  ctx.log(`BaitNet demo — registry ${ctx.env.registry.contractId} (${ctx.env.network}), LLM ${llm.name}`);
  const scripts = opts.scripts ?? ["investment", "pig-butchering", "fake-support"];
  for (const s of scripts) {
    const conv = await stepBait(ctx, s, llm);
    await stepExtractAndReport(ctx, conv);
  }
  const pay = await stepPaymentAgent(ctx);
  const solver = await stepSolver(ctx);
  await stepTrace(ctx);
  const acks = await stepResponders(ctx);
  header(ctx.log, "Summary");
  const alerts = await ctx.env.registry.listAlerts(0, 100);
  ctx.log(`  alerts on registry: ${alerts.length}; guard events: ${pay.length + solver.length}; acks: ${acks}; reports: ${readReports().length}`);
  return { alerts, events: [...pay, ...solver] };
}
