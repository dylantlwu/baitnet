import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AlertDraft,
  ArenaEngine,
  ArenaModelChoice,
  ArenaEvent,
  ArenaSession,
  ArenaSide,
  ArenaTurn,
  Conversation,
  DecoyPersona,
  Lang,
  ScamScript,
  ScamScriptDef,
  SideMode,
  SessionRating,
  SessionChannel,
} from "@baitnet/shared";
import { safeTargetKey, type RegistryClient } from "@baitnet/guard";
import {
  canonicalJson,
  extractFromText,
  redactText,
  sealConversationEvidence,
  sha256Hex,
  saveReport,
  extractFromConversation,
  type AccountAgeCheck,
  type KnownEntityFilter,
  type LLMProvider,
  type ChatMessage,
} from "@baitnet/agent";
import { detectLang, rng } from "./lang.js";
import { ageReason, knownEntityReason } from "./i18n.js";
import { RulesBait, RulesScammer, type ScammerPlan } from "./rules.js";
import { baitSystemPrompt, scammerSystemPrompt } from "./prompts.js";
import { filterBaitText, isInjection, looksHijacked } from "./safety.js";
import type { PlaybookRetriever } from "./deps.js";
import { decoyReadyPlaybook, hasPlaceholder, naturalizePlaceholders } from "./placeholders.js";
import { initDecoyMind, selectPersona } from "./personas.js";
import { checkDraft, describeHits, type CheckHit } from "./decoy-checks.js";
import { codeIntel, parseDecoyOutput, updateDecoyMind, type DecoyOutput } from "./decoy-mind.js";

/** Bait answers carry a JSON mind (think / plan / facts …) now; 400 tokens could cut the reply off. */
const BAIT_MAX_TOKENS = 900;

export type ArenaDraft = ArenaSession["drafts"][number];

export interface SessionDeps {
  engine: ArenaEngine;
  llm?: LLMProvider;
  /** D30: the model the expert picked (recorded on the session; `llm` is what it resolved to) */
  modelChoice?: ArenaModelChoice;
  registry: RegistryClient;
  retriever: PlaybookRetriever;
  known: KnownEntityFilter;
  age: AccountAgeCheck;
  /** eval mode: approve L1 drafts automatically (still logged as review) */
  autoApprove?: boolean;
  stepDelayMs?: number;
  maxTurns?: number;
  persist?: (s: ArenaSession) => void;
  /** Called before every LLM call; false = over today's quota → this session downgrades to rules. */
  llmGate?: () => boolean | Promise<boolean>;
  now?: () => Date;
  log?: (s: string) => void;
}

export interface SessionMetrics {
  injectionTurns: number[];
  hijackTurns: number[];
  safetyEvents: { turn: number; rule: string }[];
  playbookHits: number;
  llmFallbacks: number;
  stageByTurn: Record<number, number>;
}

/**
 * Not an ArenaEvent (packages/shared is frozen): emitted as the engine's "typing" event while an AI line is
 * generated; the server forwards it on the SSE stream so the web can show "typing…".
 */
export interface ArenaTypingEvent {
  type: "typing";
  sessionId: string;
  side: ArenaSide;
  on: boolean;
}

const other = (s: ArenaSide): ArenaSide => (s === "scammer" ? "bait" : "scammer");

/**
 * One arena conversation. Each side is ai / human / ai+whisper and can be
 * switched at any time. run() auto-plays AI turns until a human side is due,
 * pause() stops after the current turn, step() plays exactly one AI turn.
 * Whispers are only fed to the side they were given to.
 */
export class ArenaSessionEngine extends EventEmitter {
  readonly session: ArenaSession;
  readonly metrics: SessionMetrics = { injectionTurns: [], hijackTurns: [], safetyEvents: [], playbookHits: 0, llmFallbacks: 0, stageByTurn: {} };
  private scammerRules: RulesScammer;
  private baitRules: RulesBait;

  /**
   * Re-open a saved session (e.g. after a server restart): status → paused,
   * rules state rebuilt from the transcript; drafts/reviews keep working.
   */
  static restore(script: ScamScriptDef, deps: SessionDeps, saved: ArenaSession): ArenaSessionEngine {
    const eng = new ArenaSessionEngine(script, deps, { id: saved.id, modes: saved.modes });
    Object.assign(eng.session, JSON.parse(JSON.stringify(saved)) as ArenaSession);
    eng.applyModel();
    // sessions saved before D32: pick their persona now (stable by id, so the same one every restart)
    if (!eng.session.persona) eng.attachPersona(selectPersona(script, saved.id));
    else eng.session.decoyMind ??= initDecoyMind(eng.session.persona);
    eng.baitRules.persona = eng.session.persona;
    if (eng.session.status === "running") eng.session.status = "paused";
    const scammer = saved.turns.filter((t) => t.side === "scammer");
    eng.scammerRules.restoreFrom(scammer.map((t) => t.text));
    eng.baitRules.remember(saved.turns.filter((t) => t.side === "bait").map((t) => t.text));
    for (const t of scammer) if (isInjection(t.text)) eng.metrics.injectionTurns.push(t.index);
    return eng;
  }
  private rand: () => number;
  private whispers: Partial<Record<ArenaSide, string>> = {};
  private busy: Promise<unknown> = Promise.resolve();
  private loop?: Promise<void>;

  constructor(
    readonly script: ScamScriptDef,
    private deps: SessionDeps,
    init: { id?: string; modes?: Partial<Record<ArenaSide, SideMode>>; channel?: SessionChannel; persona?: DecoyPersona } = {},
  ) {
    super();
    const id = init.id ?? `arena-${randomUUID().slice(0, 8)}`;
    this.rand = rng(`${id}:${script.id}`);
    this.scammerRules = new RulesScammer(script, this.rand);
    this.baitRules = new RulesBait(this.rand);
    this.session = {
      id,
      scriptId: script.id,
      engine: deps.engine,
      ...(deps.modelChoice ? { modelChoice: deps.modelChoice } : {}),
      ...(deps.engine !== "rules" && deps.llm?.model ? { model: deps.llm.model } : {}),
      modes: { scammer: init.modes?.scammer ?? "ai", bait: init.modes?.bait ?? "ai" },
      status: "paused",
      turns: [],
      drafts: [],
      ...(init.channel ? { channel: init.channel } : {}),
      createdAt: this.now().toISOString(),
    };
    this.attachPersona(init.persona ?? selectPersona(script, id));
  }

  /** D32: snapshot the character card on the session and start an empty mind. */
  private attachPersona(p: DecoyPersona | undefined) {
    if (!p) return;
    this.session.persona = JSON.parse(JSON.stringify(p)) as DecoyPersona;
    this.session.decoyMind = initDecoyMind(p);
    this.baitRules.persona = this.session.persona;
  }

  /** session.engine / model / modelChoice from deps (rules = no model). */
  private applyModel() {
    this.session.engine = this.deps.engine;
    if (this.deps.modelChoice) this.session.modelChoice = this.deps.modelChoice;
    if (this.deps.engine !== "rules" && this.deps.llm?.model) this.session.model = this.deps.llm.model;
    else delete this.session.model;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private emitEvent(e: ArenaEvent) {
    this.emit("event", e);
    this.deps.persist?.(this.session);
  }
  private log(s: string) {
    this.deps.log?.(s);
  }

  get maxTurns() {
    return this.deps.maxTurns ?? 24;
  }
  get nextSide(): ArenaSide {
    const last = this.session.turns.at(-1);
    return last ? other(last.side) : "scammer";
  }
  get lang(): Lang {
    const lastScammer = [...this.session.turns].reverse().find((t) => t.side === "scammer");
    return lastScammer ? detectLang(lastScammer.text, this.script.lang) : this.script.lang;
  }
  get done(): boolean {
    const t = this.session.turns;
    return t.length >= this.maxTurns || (this.scammerRules.finished && t.at(-1)?.side === "bait");
  }

  // ------------------------------------------------------------------ controls
  setMode(side: ArenaSide, mode: SideMode) {
    this.session.modes[side] = mode;
    if (mode !== "ai+whisper" && mode !== "ai") delete this.whispers[side];
    this.emitEvent({ type: "mode", sessionId: this.session.id, side, mode });
    if (this.session.status === "running") this.kick();
  }

  whisper(side: ArenaSide, text: string) {
    if (this.session.modes[side] === "human") throw new Error(`${side} is human-controlled; whisper only goes to an AI side`);
    if (this.session.modes[side] !== "ai+whisper") this.setMode(side, "ai+whisper");
    this.whispers[side] = text;
  }

  /**
   * Human speaks for `side` (switches that side to human = takeover).
   * `autoReply` (web): when the other side is AI ("ai" / "ai+whisper") it answers once, queued right
   * behind this line on the same exclusive queue, so a concurrent step() / second say() never makes it
   * answer twice. The HTTP call returns as soon as the human line is stored; the reply arrives as a turn
   * event, with "typing" events around it. Telegram drives its own reply (router.aiReply) and leaves this off.
   */
  async say(side: ArenaSide, text: string, opts: { autoReply?: boolean } = {}): Promise<ArenaTurn> {
    if (this.session.status === "finished") throw new Error("session finished");
    if (this.session.modes[side] !== "human") this.setMode(side, "human");
    const p = this.exclusive(async () => {
      if (side === "scammer") this.scammerRules.commitHuman(text);
      const turn = this.pushTurn({ side, text, author: "human" });
      if (side === "scammer") await this.afterScammer(turn);
      if (this.session.status === "running") this.kick();
      return turn;
    });
    if (opts.autoReply) this.lastAutoReply = this.autoReply();
    return p;
  }

  /** The auto reply queued by the last say({autoReply}) (tests / callers that want to wait for it). */
  lastAutoReply: Promise<ArenaTurn | null> = Promise.resolve(null);

  /**
   * One AI answer after a human line. No-op when the run loop is on (it answers by itself), when the next
   * side is human (both sides human, or the AI already answered), or when the session is done.
   */
  private autoReply(): Promise<ArenaTurn | null> {
    return this.exclusive(async () => {
      if (this.session.status === "running") return null;
      return this.stepInner();
    }).catch((e: Error) => {
      this.log(`[arena] ${this.session.id}: auto reply failed: ${e.message}`);
      return null;
    });
  }

  /** Side whose AI line is being generated right now (web "typing…"), null when idle. */
  typing: ArenaSide | null = null;
  private setTyping(side: ArenaSide | null) {
    if (this.typing === side) return;
    const prev = this.typing;
    this.typing = side;
    this.emit("typing", { type: "typing", sessionId: this.session.id, side: (side ?? prev)!, on: side !== null } satisfies ArenaTypingEvent);
  }

  /** Play exactly one AI turn (if the next side is AI). Returns null when a human is due or finished. */
  async step(): Promise<ArenaTurn | null> {
    return this.exclusive(() => this.stepInner());
  }

  run(): Promise<void> {
    if (this.session.status === "finished") return Promise.resolve();
    this.setStatus("running");
    return this.kick();
  }

  pause() {
    if (this.session.status === "running") this.setStatus("paused");
  }

  /** End the session (e.g. IM /end): no further turns; drafts can still be reviewed. */
  finish() {
    if (this.session.status !== "finished") this.setStatus("finished");
  }

  /** Switch this session's engine; only "rules" (downgrade, e.g. daily LLM quota used up). */
  setEngine(engine: "rules") {
    if (engine !== "rules") throw new Error("setEngine only supports downgrading to rules");
    this.deps.llm = undefined;
    if (this.session.engine !== "rules" || this.session.model) {
      this.session.engine = "rules";
      delete this.session.model;
      this.deps.persist?.(this.session);
    }
  }

  /** Wait for the current run loop (tests/eval). */
  idle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  private kick(): Promise<void> {
    if (this.loop) return this.loop;
    this.loop = (async () => {
      // yield first: if the loop ended synchronously (a human side is due), `finally` would clear
      // this.loop before the assignment below and leave a stale, settled loop that blocks every later kick()
      await Promise.resolve();
      try {
        while (this.session.status === "running") {
          if (this.done) {
            this.setStatus("finished");
            break;
          }
          if (this.session.modes[this.nextSide] === "human") break; // wait for say()
          const t = await this.step();
          if (!t) break;
          const d = this.deps.stepDelayMs ?? 0;
          if (d) await new Promise((r) => setTimeout(r, d));
        }
      } finally {
        this.loop = undefined;
      }
    })();
    return this.loop;
  }

  private setStatus(s: ArenaSession["status"]) {
    this.session.status = s;
    this.emitEvent({ type: "status", sessionId: this.session.id, status: s });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => {});
    return p;
  }

  private pushTurn(t: Omit<ArenaTurn, "index" | "ts">): ArenaTurn {
    const turn: ArenaTurn = { index: this.session.turns.length, ts: this.now().toISOString(), ...t };
    this.session.turns.push(turn);
    this.emitEvent({ type: "turn", sessionId: this.session.id, turn });
    return turn;
  }

  private async stepInner(): Promise<ArenaTurn | null> {
    if (this.session.status === "finished" || this.done) {
      if (this.session.status !== "finished") this.setStatus("finished");
      return null;
    }
    const side = this.nextSide;
    if (this.session.modes[side] === "human") return null;
    const whisper = this.session.modes[side] === "ai+whisper" ? this.whispers[side] : undefined;
    delete this.whispers[side]; // a whisper applies to the next AI turn of that side only
    this.setTyping(side);
    try {
      if (side === "scammer") {
        const turn = await this.scammerTurn(whisper);
        await this.afterScammer(turn);
        return turn;
      }
      return await this.baitTurn(whisper);
    } finally {
      this.setTyping(null);
    }
  }

  /** true if this turn may use the LLM (quota check); downgrades the session to rules otherwise. */
  private async llmAllowed(side: ArenaSide): Promise<boolean> {
    if (!this.deps.llm) return false;
    if (!this.deps.llmGate) return true;
    if (await this.deps.llmGate()) return true;
    this.setEngine("rules");
    this.log(`[arena] ${this.session.id}: daily LLM quota used up → rules mode`);
    this.emitEvent({ type: "safety", sessionId: this.session.id, side, rule: "llm-quota-exceeded" });
    return false;
  }

  // ------------------------------------------------------------------ scammer
  private async scammerTurn(whisper?: string): Promise<ArenaTurn> {
    const lastBait = [...this.session.turns].reverse().find((t) => t.side === "bait")?.text;
    let text: string;
    let plan: ScammerPlan;
    if (await this.llmAllowed("scammer")) {
      plan = this.scammerRules.plan();
      try {
        text = await this.deps.llm!.complete({ system: scammerSystemPrompt(this.script, plan, whisper), messages: this.messagesFor("scammer") });
        // guarantee the planted artifacts / injection really appear (eval depends on it)
        for (const a of plan.reveal) if (!text.includes(a.value)) text += (this.script.lang === "zh" ? "\n" : " ") + this.scammerRules.revealLine(a);
        if (plan.injection && !text.includes(plan.injection)) text += (this.script.lang === "zh" ? "\n" : " ") + plan.injection;
        this.scammerRules.commit(plan, text);
      } catch (e) {
        this.metrics.llmFallbacks++;
        this.log(`[arena] scammer LLM failed (${(e as Error).message}); rules fallback`);
        ({ text, plan } = this.scammerRules.next(lastBait));
      }
    } else ({ text, plan } = this.scammerRules.next(lastBait));
    const turn = this.pushTurn({ side: "scammer", text, author: "ai", ...(whisper ? { whisper } : {}) });
    this.metrics.stageByTurn[turn.index] = plan.stage;
    if (plan.injection) this.metrics.injectionTurns.push(turn.index);
    return turn;
  }

  /** M2 on every scammer message: extract → filter → pending drafts. */
  private async afterScammer(turn: ArenaTurn) {
    if (!this.metrics.injectionTurns.includes(turn.index) && isInjection(turn.text)) this.metrics.injectionTurns.push(turn.index);
    const ex = extractFromText(turn.text);
    for (const a of ex.addresses) {
      const key = safeTargetKey(a);
      if (this.session.drafts.some((d) => safeTargetKey(d) === key)) continue;
      const draft: ArenaDraft = {
        chain: a.chain,
        address: a.address,
        level: "L1",
        category: this.script.type,
        evidenceHash: this.provisionalHash(),
        conversationId: this.session.id,
        review: "pending",
      };
      const ent = this.deps.known.match(a);
      if (ent) {
        draft.filteredReason = knownEntityReason(ent.name, ent.kind, this.script.lang);
        draft.review = "rejected";
      } else {
        const age = await this.deps.age.check(a);
        if (!age.ok) {
          draft.filteredReason = ageReason(age.detail, this.script.lang);
          draft.review = "rejected";
        }
      }
      this.session.drafts.push(draft);
      const idx = this.session.drafts.length - 1;
      this.emitEvent({ type: "draft", sessionId: this.session.id, draftIndex: idx, draft });
      if (this.deps.autoApprove && draft.review === "pending") await this.review(idx, true, "eval-auto");
    }
  }

  private provisionalHash(): string {
    return sha256Hex(canonicalJson({ sessionId: this.session.id, scriptId: this.script.id, turns: this.session.turns.map((t) => ({ side: t.side, text: redactText(t.text) })) }));
  }

  // ------------------------------------------------------------------ bait
  private async baitTurn(whisper?: string): Promise<ArenaTurn> {
    const lastScammer = [...this.session.turns].reverse().find((t) => t.side === "scammer");
    const scammerText = lastScammer?.text ?? "";
    const lang = this.lang;
    const persona = this.session.persona;
    const stage = lastScammer ? (this.metrics.stageByTurn[lastScammer.index] ?? this.scammerRules.stageFor(Math.max(0, this.scammerRules.scammerTurns - 1))) : 0;
    let playbook: Awaited<ReturnType<PlaybookRetriever["search"]>> = [];
    try {
      // placeholders ([NAME_1]…) from redaction become natural wording; examples that cannot be fixed are dropped
      playbook = decoyReadyPlaybook(await this.deps.retriever.search({ scamType: this.script.type, stage, lastScammerText: scammerText, k: 3 }), lang, persona?.name);
    } catch (e) {
      this.log(`[arena] playbook search failed: ${(e as Error).message}`);
    }
    if (playbook.length) this.metrics.playbookHits++;

    let draft: string;
    let out: DecoyOutput | undefined; // set only when the LLM wrote the line
    if (await this.llmAllowed("bait")) {
      try {
        out = await this.llmBait(lang, playbook, whisper);
        draft = out.reply;
        if (!draft.trim()) throw new Error("no usable reply in the model output");
      } catch (e) {
        out = undefined;
        this.metrics.llmFallbacks++;
        this.log(`[arena] bait LLM failed (${(e as Error).message}); rules fallback`);
        draft = this.rulesBait(scammerText, lang, playbook, whisper);
      }
    } else draft = this.rulesBait(scammerText, lang, playbook, whisper);

    // never send the exact same bait line twice in a row (rules engine, or a looping LLM)
    const prevBait = [...this.session.turns].reverse().find((t) => t.side === "bait")?.text;
    if (prevBait && draft.trim() === prevBait.trim()) {
      draft = this.rulesBait(scammerText, lang, [], undefined);
      // the facts belonged to the replaced line; keep think/plan only
      if (out?.mind?.newFacts) out = { ...out, mind: { think: out.mind.think, ...(out.mind.plan ? { plan: out.mind.plan } : {}) } };
    }
    // belt and braces: a decoy line never carries a redaction placeholder
    if (hasPlaceholder(draft)) draft = naturalizePlaceholders(draft, lang, persona?.name);
    const lastWasInjection = lastScammer ? this.metrics.injectionTurns.includes(lastScammer.index) : false;
    if (lastWasInjection && looksHijacked(draft)) this.metrics.hijackTurns.push(this.session.turns.length);
    const f = filterBaitText(draft, lang, this.rand, { haveAddress: this.session.drafts.length > 0, stallExcuses: this.session.persona?.stallExcuses });
    // D32: update the hidden mind before the turn is pushed (pushTurn persists the session)
    const mind = this.session.decoyMind;
    if (mind) {
      const firstScore = !this.session.turns.some((t) => t.side === "bait" && t.mind);
      const scammerTexts = this.session.turns.filter((t) => t.side === "scammer").map((t) => t.text);
      updateDecoyMind(mind, this.session.turns.length, out, codeIntel(scammerTexts, persona?.lang ?? lang), { firstScore });
    }
    const turn = this.pushTurn({
      side: "bait",
      text: f.text,
      author: "ai",
      ...(out?.mind ? { mind: out.mind } : {}),
      ...(whisper ? { whisper } : {}),
      ...(f.blocked ? { safety: { blocked: true, rule: f.rule!, original: f.original } } : {}),
    });
    if (f.blocked) {
      this.metrics.safetyEvents.push({ turn: turn.index, rule: f.rule! });
      this.emitEvent({ type: "safety", sessionId: this.session.id, side: "bait", rule: f.rule!, turnIndex: turn.index });
    }
    return turn;
  }

  /**
   * D32 LLM bait line: layered prompt → JSON → post-checks → at most one rewrite (same prompt + "上一稿的问题")
   * → the draft with fewer issues. Every hit is recorded in decoyMind.checks. filterBaitText runs after this.
   */
  private async llmBait(lang: Lang, playbook: Awaited<ReturnType<PlaybookRetriever["search"]>>, whisper?: string): Promise<DecoyOutput> {
    const persona = this.session.persona;
    const mind = this.session.decoyMind;
    const messages = this.decoyJsonMessages(lang);
    const ask = async (rewriteNote?: string) =>
      parseDecoyOutput(await this.deps.llm!.complete({ system: baitSystemPrompt(lang, playbook, whisper, { persona, mind, rewriteNote }), messages, maxTokens: BAIT_MAX_TOKENS }));
    const first = await ask();
    if (!persona || !mind || !first.reply.trim()) return first;
    const turn = this.session.turns.length;
    const ctx = {
      persona,
      facts: mind.facts.map((x) => x.fact),
      scammerText: this.session.turns.filter((t) => t.side === "scammer").map((t) => t.text).join("\n"),
    };
    const hits1 = checkDraft(first.reply, first.mind?.newFacts ?? [], ctx);
    if (!hits1.length) return first;
    let second: DecoyOutput | undefined;
    let hits2: CheckHit[] | undefined;
    // the rewrite is a second model call: it counts against the daily quota too (no quota → keep the draft)
    if (!this.deps.llmGate || (await this.deps.llmGate())) {
      try {
        second = await ask(describeHits(hits1, lang));
        if (second.reply.trim()) hits2 = checkDraft(second.reply, second.mind?.newFacts ?? [], ctx);
      } catch (e) {
        this.log(`[arena] bait rewrite failed (${(e as Error).message}); keeping the first draft`);
      }
    }
    const useSecond = !!second && !!hits2 && hits2.length < hits1.length;
    const tried = !!hits2;
    for (const h of hits1) mind.checks.push({ turn, issue: h.issue, detail: tried && !useSecond ? `${h.detail} (rewrite was not better; kept)` : h.detail, rewritten: tried });
    if (useSecond) for (const h of hits2!) mind.checks.push({ turn, issue: h.issue, detail: `after rewrite: ${h.detail}`, rewritten: false });
    return useSecond ? second! : first;
  }

  private rulesBait(scammerText: string, lang: Lang, playbook: Awaited<ReturnType<PlaybookRetriever["search"]>>, whisper?: string): string {
    const known = this.session.drafts.map((d) => ({ chain: d.chain, address: d.address }));
    const lastScammerIdx = [...this.session.turns].reverse().find((t) => t.side === "scammer")?.index;
    const newAddr = this.session.drafts.find((d) => scammerText.normalize("NFKC").replace(/\s+/g, "").includes(d.address));
    const hasUrl = this.session.turns.some((t) => t.side === "scammer" && /https?:\/\//.test(t.text));
    const r = this.baitRules.next({
      scammerText,
      lang,
      scamType: this.script.type,
      knownAddresses: known,
      newAddress: newAddr && lastScammerIdx !== undefined ? { chain: newAddr.chain, address: newAddr.address } : undefined,
      hasUrl,
      baitTurns: this.session.turns.filter((t) => t.side === "bait").length,
      playbook,
      whisper,
    });
    return r.text;
  }

  /** Chat history from one side's perspective: turn text only; whispers, persona and mind are never included. */
  private messagesFor(me: ArenaSide): ChatMessage[] {
    const msgs: ChatMessage[] = this.session.turns.map((t) => ({ role: t.side === me ? "assistant" : "user", content: t.text }));
    while (msgs.length && msgs[0]!.role === "assistant") msgs.shift();
    if (!msgs.length) msgs.push({ role: "user", content: me === "scammer" ? "(Start the conversation with your opening hook.)" : "(The other side has not said anything yet.)" });
    return msgs;
  }

  /**
   * History for the JSON-speaking decoy: earlier bait lines are shown as {"reply": …} (with their stored
   * think / plan when present) so the model keeps answering in JSON instead of copying its plain-text past
   * replies (measured 2026-11-11: DeepSeek drifted to plain text from the 2nd reply on). The last message
   * ends with a one-line format reminder. Still turn text only: no whispers, no persona.
   */
  private decoyJsonMessages(lang: Lang): ChatMessage[] {
    const msgs: ChatMessage[] = this.session.turns.map((t) => {
      if (t.side !== "bait") return { role: "user", content: t.text };
      const o: Record<string, unknown> = {};
      if (t.mind?.think) o.think = t.mind.think;
      if (t.mind?.plan) o.plan = t.mind.plan;
      if (t.mind?.newFacts?.length) o.new_facts = t.mind.newFacts;
      o.reply = t.text;
      return { role: "assistant", content: JSON.stringify(o) };
    });
    while (msgs.length && msgs[0]!.role === "assistant") msgs.shift();
    if (!msgs.length) msgs.push({ role: "user", content: "(The other side has not said anything yet.)" });
    const last = msgs[msgs.length - 1]!;
    if (last.role === "user")
      last.content += lang === "zh" ? "\n\n（按【输出格式】只回一个 JSON；这一轮提到自己的新细节都写进 new_facts）" : "\n\n(Answer with ONE JSON object as in [Output format]; put every new detail about yourself into new_facts.)";
    return msgs;
  }

  /** Expert's overall rating (training mode). */
  rate(r: { expertId: string; score: number; note?: string }): SessionRating {
    const rating = validateRating(r, this.now());
    this.session.rating = rating;
    this.deps.persist?.(this.session);
    this.emit("rated", rating);
    return rating;
  }

  // ------------------------------------------------------------------ review → chain
  async review(draftIndex: number, approve: boolean, reviewer = "operator"): Promise<ArenaDraft> {
    const d = this.session.drafts[draftIndex];
    if (!d) throw new Error(`no draft ${draftIndex}`);
    if (d.review !== "pending") throw new Error(`draft ${draftIndex} already ${d.review}${d.filteredReason ? ` (${d.filteredReason})` : ""}`);
    if (!approve) {
      d.review = "rejected";
      this.emitEvent({ type: "draft", sessionId: this.session.id, draftIndex, draft: d });
      return d;
    }
    // seal evidence for the conversation so far (PII → encrypted only) and report
    const conv: Conversation = {
      id: this.session.id,
      script: this.script.type as ScamScript,
      provider: this.session.engine === "rules" ? "replay" : this.session.engine,
      turns: this.session.turns.map((t) => ({ role: t.side, text: t.text, ts: t.ts })),
    };
    const sealed = sealConversationEvidence(conv, extractFromConversation(conv));
    d.evidenceHash = sealed.evidenceHash;
    const draft: AlertDraft = { chain: d.chain, address: d.address, level: d.level, category: d.category, evidenceHash: d.evidenceHash, conversationId: d.conversationId };
    const r = await this.deps.registry.report({ address: draft.address, chain: draft.chain, evidenceHash: draft.evidenceHash, level: draft.level, category: draft.category });
    d.review = "approved";
    d.alertId = r.value;
    if (r.txHash) d.txHash = r.txHash;
    saveReport({ alertId: r.value, chain: d.chain, address: d.address, txHash: r.txHash, evidenceHash: d.evidenceHash, conversationId: d.conversationId, at: this.now().toISOString() });
    this.log(`[review] ${reviewer} approved ${d.chain}:${d.address} → alert #${r.value} tx ${r.txHash ?? "-"}`);
    this.emitEvent({ type: "draft", sessionId: this.session.id, draftIndex, draft: d });
    this.emitEvent({ type: "onchain", sessionId: this.session.id, draftIndex, alertId: r.value, ...(r.txHash ? { txHash: r.txHash } : {}) });
    return d;
  }
}

export function validateRating(r: { expertId?: unknown; score?: unknown; note?: unknown }, now = new Date()): SessionRating {
  if (typeof r.expertId !== "string" || !r.expertId.trim()) throw Object.assign(new Error("expertId required"), { status: 400 });
  const score = Number(r.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw Object.assign(new Error("score must be an integer 1-5"), { status: 400 });
  if (r.note !== undefined && typeof r.note !== "string") throw Object.assign(new Error("note must be a string"), { status: 400 });
  return { expertId: r.expertId.trim(), score: score as SessionRating["score"], note: ((r.note as string) ?? "").slice(0, 2000), at: now.toISOString() };
}
