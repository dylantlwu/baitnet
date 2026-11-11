import { randomBytes } from "node:crypto";
import { arenaModelTier, isArenaModelChoice, type ArenaSessionEngine } from "@baitnet/arena";
import { ARENA_MODELS, type ArenaModelChoice, type ArenaEvent, type ArenaSide, type ArenaTurn, type Lang, type ScamScriptDef, type ScamType, type ScriptUpload, type User } from "@baitnet/shared";
import { delayScale, maybeSplit, typingDelayMs } from "./humanize.js";
import { COMMANDS, T, TYPE_LABEL, baitName, langOf, piiLabel, type Strings } from "./i18n.js";
import { ImState, shanghai } from "./state.js";
import type { Button, ButtonPress, ChannelAdapter, ChannelHandlers, ImDeps, ImUser, InMessage, OutMessage } from "./types.js";
import { sleep } from "./telegram/api.js";

const other = (s: ArenaSide): ArenaSide => (s === "scammer" ? "bait" : "scammer");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const AUTO_BATCH = 6; // AI-vs-AI turns before asking "continue?"
const PENDING_TTL_MS = 30 * 60_000;
const MAX_BIND_FAILS = 5;
const TEXT_EXT = /\.(txt|md|markdown|json|csv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

interface Ctx {
  chatId: string;
  user: User;
  lang: Lang;
  t: Strings;
}

/**
 * Session router (docs/03_IM训练台设计.md §4, docs/dev/im-contract.md).
 * One private chat ↔ one running arena session. Channel-agnostic: talks to a ChannelAdapter only.
 */
export class SessionRouter {
  private queues = new Map<string, Promise<unknown>>();
  private subs = new Map<string, () => void>();
  private autoTok = new Map<string, number>();
  private reviewing = new Set<string>();
  private pendingUploads = new Map<string, { userId: string; chatId: string; msg: InMessage; at: number }>();
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private scale: number;

  constructor(
    private deps: ImDeps,
    private adapter: ChannelAdapter,
    readonly state: ImState,
  ) {
    this.scale = delayScale(deps.env ?? process.env);
  }

  get kind() {
    return this.adapter.kind;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private rand() {
    return (this.deps.random ?? Math.random)();
  }
  private log(s: string) {
    this.deps.log?.(s);
  }

  handlers(): ChannelHandlers {
    return {
      onMessage: (m) => this.onMessage(m),
      onButton: (b) => this.onButton(b),
    };
  }

  /** Command menu (zh default + en). */
  async setup() {
    await this.adapter.setCommands(COMMANDS.zh);
    await this.adapter.setCommands(COMMANDS.en, "en");
  }

  startTimers(intervalMs = 60_000) {
    this.timers.push(setInterval(() => void this.runDigestIfDue().catch((e) => this.log(`[im] digest failed: ${(e as Error).message}`)), intervalMs));
  }

  async stop() {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const off of this.subs.values()) off();
    this.subs.clear();
    await Promise.allSettled([...this.queues.values()]);
  }

  // ───────────────────────── plumbing ─────────────────────────

  /** Per-chat FIFO so a chat's messages are handled in order (and the engine is never re-entered). */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.then(
      () => {},
      () => {},
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return p;
  }

  private async send(chatId: string, m: OutMessage | string) {
    return this.adapter.send(chatId, typeof m === "string" ? { text: m } : m);
  }

  private async audit(user: User, action: string, target?: string, detail?: string) {
    try {
      await this.deps.identity.audit({ expertId: user.id, action, ...(target ? { target } : {}), ...(detail ? { detail: clip(detail, 300) } : {}) });
    } catch (e) {
      this.log(`[im] audit failed: ${(e as Error).message}`);
    }
  }

  private names = new Map<string, string>();
  private remember(user: User, chatId: string, im: ImUser) {
    this.names.set(user.id, user.name);
    const lang = langOf(im.langCode);
    if (this.state.data.userChat[user.id] !== chatId || this.state.data.userLang[user.id] !== lang)
      this.state.update((d) => {
        d.userChat[user.id] = chatId;
        d.userLang[user.id] = lang;
      });
  }

  private langFor(userId: string): Lang {
    return this.state.data.userLang[userId] ?? "zh";
  }

  /** Typing indicator for `ms`, refreshed every 4 s (Telegram clears it after ~5 s). */
  private async pause(chatId: string, ms: number) {
    const end = Date.now() + ms;
    for (;;) {
      void this.adapter.typing(chatId);
      const left = end - Date.now();
      if (left <= 0 || this.stopping) break;
      await sleep(Math.min(4000, left));
    }
  }

  // ───────────────────────── incoming messages ─────────────────────────

  async onMessage(m: InMessage) {
    if (!m.isPrivate) return; // group spectating comes after the hackathon
    await this.enqueue(m.chatId, () => this.handleMessage(m)).catch(async (e) => {
      this.log(`[im] message handler failed: ${(e as Error)?.stack ?? e}`);
      try {
        await this.send(m.chatId, T[langOf(m.user.langCode)].error);
      } catch {
        /* ignore */
      }
    });
  }

  private parseCommand(text?: string): { name: string; arg: string } | undefined {
    const mm = text?.trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    return mm ? { name: mm[1]!.toLowerCase(), arg: (mm[2] ?? "").trim() } : undefined;
  }

  private async handleMessage(m: InMessage) {
    const lang = langOf(m.user.langCode);
    const t = T[lang];
    const kind = this.kind;
    const cmd = this.parseCommand(m.text);
    const user = await this.deps.identity.userByBinding(kind, m.user.externalId);

    if (!user) {
      // whitelist: unbound accounts may only bind; at most one hint, then silence
      if (cmd?.name === "start" && cmd.arg) return this.tryBind(m, cmd.arg, t);
      if (!this.state.data.nagged.includes(m.user.externalId)) {
        this.state.update((d) => void d.nagged.push(m.user.externalId));
        await this.send(m.chatId, t.needBind);
      }
      return;
    }
    this.remember(user, m.chatId, m.user);
    const ctx: Ctx = { chatId: m.chatId, user, lang, t };

    if (cmd) {
      if (this.state.data.pending[m.chatId] && cmd.name !== "status" && cmd.name !== "help") this.state.update((d) => void delete d.pending[m.chatId]);
      switch (cmd.name) {
        case "start":
          if (cmd.arg) {
            const u = await this.deps.identity.bindByCode(kind, m.user.externalId, m.user.username, cmd.arg);
            if (u) {
              await this.audit(u, "im.bind", `${kind}:${m.user.externalId}`);
              return void (await this.send(m.chatId, t.welcome(u.name, u.role)));
            }
          }
          return void (await this.send(m.chatId, t.welcomeBack(user.name)));
        case "help":
          return void (await this.send(m.chatId, t.help(user.role === "reviewer")));
        case "new":
          return this.cmdNew(ctx);
        case "w":
          return this.cmdWhisper(ctx, cmd.arg);
        case "mode":
          return this.cmdMode(ctx);
        case "end":
          return this.cmdEnd(ctx);
        case "status":
          return this.cmdStatus(ctx);
        default:
          return void (await this.send(m.chatId, t.help(user.role === "reviewer")));
      }
    }

    if (m.images?.length || m.file) return this.handleUpload(ctx, m);
    const text = m.text?.trim();
    if (!text) return;

    const pending = this.state.data.pending[m.chatId];
    if (pending) {
      this.state.update((d) => void delete d.pending[m.chatId]);
      if (this.now().getTime() - Date.parse(pending.at) < PENDING_TTL_MS) {
        if (pending.kind === "edit") return this.fileCorrection(ctx, pending.sessionId, pending.turnIndex, text);
        if (pending.kind === "note") return this.finishRating(ctx, pending.sessionId, pending.score, text);
      }
    }
    return this.chat(ctx, text, m.messageId);
  }

  private async tryBind(m: InMessage, code: string, t: Strings) {
    const day = shanghai(this.now()).day;
    const id = m.user.externalId;
    const f = this.state.data.bindFails[id];
    const fails = f && f.day === day ? f.n : 0;
    if (fails >= MAX_BIND_FAILS) return; // silent: brute-force guard
    const u = await this.deps.identity.bindByCode(this.kind, id, m.user.username, code);
    if (!u) {
      this.state.update((d) => void (d.bindFails[id] = { day, n: fails + 1 }));
      await this.send(m.chatId, fails + 1 >= MAX_BIND_FAILS ? t.tooManyFails : t.badCode);
      return;
    }
    this.state.update((d) => {
      d.nagged = d.nagged.filter((x) => x !== id);
      delete d.bindFails[id];
    });
    this.remember(u, m.chatId, m.user);
    await this.audit(u, "im.bind", `${this.kind}:${id}`, m.user.username);
    await this.send(m.chatId, t.welcome(u.name, u.role));
  }

  // ───────────────────────── sessions ─────────────────────────

  /** Live engine for this chat; restores from disk after a restart; clears stale mappings. */
  private async active(chatId: string): Promise<{ eng?: ArenaSessionEngine; gone?: boolean }> {
    const sid = await this.deps.chats.get(this.kind, chatId);
    if (!sid) return {};
    let eng = this.deps.arena.get(sid);
    if (!eng) {
      try {
        await this.deps.arena.restore();
      } catch (e) {
        this.log(`[im] arena.restore failed: ${(e as Error).message}`);
      }
      eng = this.deps.arena.get(sid);
    }
    if (!eng || eng.session.status === "finished") {
      await this.deps.chats.clear(this.kind, chatId);
      return { gone: true };
    }
    this.subscribe(eng);
    return { eng };
  }

  private plays(eng: ArenaSessionEngine): ArenaSide {
    return eng.session.channel?.expertPlays === "bait" ? "bait" : "scammer";
  }
  private view(sid: string) {
    return this.state.data.view[sid] ?? "human";
  }

  private subscribe(eng: ArenaSessionEngine) {
    const sid = eng.session.id;
    if (this.subs.has(sid)) return;
    try {
      const off = this.deps.arena.subscribe(sid, (e) => void this.onArenaEvent(eng, e).catch((err) => this.log(`[im] event handler: ${(err as Error).message}`)));
      this.subs.set(sid, off);
    } catch {
      /* not live */
    }
  }

  private async cmdNew(ctx: Ctx) {
    const { eng } = await this.active(ctx.chatId);
    if (eng) return void (await this.send(ctx.chatId, ctx.t.hasActive));
    await this.send(ctx.chatId, {
      text: ctx.t.pickSide,
      buttons: [[{ text: ctx.t.sideScammer, payload: "n:s" }, { text: ctx.t.sideBait, payload: "n:b" }]],
    });
  }

  private async scriptsByType(lang: Lang): Promise<Map<ScamType, ScamScriptDef[]>> {
    const all = await this.deps.arena.scripts();
    const by = new Map<ScamType, ScamScriptDef[]>();
    for (const s of all) by.set(s.type, [...(by.get(s.type) ?? []), s]);
    // the user's language first, then by id (stable index for button payloads)
    for (const [k, v] of by) by.set(k, v.sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang) || a.id.localeCompare(b.id)));
    return by;
  }

  private async wizard(ctx: Ctx, b: ButtonPress, parts: string[]) {
    const t = ctx.t;
    const side: ArenaSide = parts[1] === "b" ? "bait" : "scammer";
    const sideLabel = t.sideName[side];
    const by = await this.scriptsByType(ctx.lang);
    if (parts.length === 2) {
      const types = [...by.keys()];
      const rows: Button[][] = [];
      for (let i = 0; i < types.length; i += 2)
        rows.push(types.slice(i, i + 2).map((ty) => ({ text: `${TYPE_LABEL[ty]?.[ctx.lang] ?? ty} (${by.get(ty)!.length})`, payload: `n:${parts[1]}:${ty}` })));
      return this.adapter.editMessage(ctx.chatId, b.messageId, { text: t.pickType(sideLabel), buttons: rows });
    }
    const type = parts[2] as ScamType;
    const list = by.get(type) ?? [];
    if (!list.length) return this.adapter.editMessage(ctx.chatId, b.messageId, { text: t.noScripts });
    if (parts.length === 3) {
      const rows: Button[][] = list.slice(0, 20).map((s, i) => [{ text: `${s.lang === "en" ? "🇬🇧 " : ""}${clip(s.title, 40)}`, payload: `n:${parts[1]}:${type}:${i}` }]);
      rows.push([{ text: t.random, payload: `n:${parts[1]}:${type}:*` }]);
      return this.adapter.editMessage(ctx.chatId, b.messageId, { text: t.pickScript(TYPE_LABEL[type]?.[ctx.lang] ?? type), buttons: rows });
    }
    // "*" is resolved here so the model step (and a re-press) keeps the same script
    const idx = parts[3] === "*" ? Math.floor(this.rand() * list.length) : Number(parts[3]);
    const pick = list[idx];
    if (!pick) return this.adapter.editMessage(ctx.chatId, b.messageId, { text: t.noScripts });
    const { eng: existing } = await this.active(ctx.chatId);
    if (existing) return this.adapter.editMessage(ctx.chatId, b.messageId, { text: t.hasActive });
    // D30: pick the model — skipped when this server has no live LLM (every choice would be rules)
    const models = this.deps.arena.models();
    if (parts.length === 4 && models.liveLLM) {
      const base = `n:${parts[1]}:${type}:${idx}`;
      const rows: Button[][] = models.models
        .filter((m) => m.available)
        .map((m) => [{ text: `${m.id === models.default ? "✅ " : ""}${t.modelBtn(m.label, m.tee, arenaModelTier(m.id, models.models))}${m.slow ? ` · ${t.modelSlow}` : ""}`, payload: `${base}:${m.id}` }]);
      rows.push([{ text: t.modelSkip, payload: `${base}:-` }]);
      return this.adapter.editMessage(ctx.chatId, b.messageId, { text: t.pickModel(pick.title), buttons: rows });
    }
    const modelChoice: ArenaModelChoice | undefined = isArenaModelChoice(parts[4]) ? parts[4] : undefined; // "-" / absent = default
    const eng = await this.createSession(ctx, side, pick, modelChoice, async (label) => {
      await this.adapter.editMessage(ctx.chatId, b.messageId, { text: `${sideLabel} · ${pick.title}${label ? ` · ${t.modelUsed(label)}` : ""}` });
    });
    return eng;
  }

  private async createSession(ctx: Ctx, side: ArenaSide, script: ScamScriptDef, modelChoice?: ArenaModelChoice, announce?: (modelLabel?: string) => Promise<unknown>) {
    const modes = side === "scammer" ? ({ scammer: "human", bait: "ai" } as const) : ({ scammer: "ai", bait: "human" } as const);
    // channel at creation: the manager's per-owner LLM quota gate (IdentityService.consumeLlmQuota) keys on ownerId
    const eng = await this.deps.arena.create(script.id, modes, { kind: this.kind, chatId: ctx.chatId, ownerId: ctx.user.id, expertPlays: side }, modelChoice);
    const s = eng.session;
    await announce?.(s.engine === "rules" ? undefined : (ARENA_MODELS.find((m) => m.model === s.model)?.label ?? s.model ?? ARENA_MODELS.find((m) => m.id === s.modelChoice)?.label));
    await this.deps.chats.set(this.kind, ctx.chatId, eng.session.id);
    this.subscribe(eng);
    await this.audit(ctx.user, "im.session.create", eng.session.id, `${side} ${script.id}${s.modelChoice ? ` ${s.modelChoice}` : ""}`);
    if (side === "scammer") {
      await this.send(ctx.chatId, ctx.t.startedScammer(script.title, script.hook, baitName(s.persona, ctx.lang)));
    } else {
      await this.send(ctx.chatId, ctx.t.startedBait(script.title));
      await this.aiReply(eng, ctx);
    }
  }

  /** Expert speaks for their side (human mode), then the AI answers. */
  private async chat(ctx: Ctx, text: string, messageId: string) {
    const { eng, gone } = await this.active(ctx.chatId);
    if (!eng) return void (await this.send(ctx.chatId, gone ? ctx.t.sessionGone : ctx.t.noSession));
    const sid = eng.session.id;
    if (this.view(sid) !== "human") return void (await this.send(ctx.chatId, ctx.t.aiModeHint));
    if (eng.done) return void (await this.send(ctx.chatId, ctx.t.sessionDone));
    const side = this.plays(eng);
    const turn = await eng.say(side, text);
    await this.audit(ctx.user, "arena.say", sid, `im ${side} #${turn.index}`);
    if (side === "bait") {
      // ⭐ under the expert's own decoy line (D15: only decoy lines are learned)
      await this.send(ctx.chatId, { text: ctx.t.starPrompt, replyToMessageId: messageId, buttons: [[{ text: ctx.t.starBtn, payload: `st:${sid}:${turn.index}` }]] });
    }
    await this.aiReply(eng, ctx);
  }

  /** One AI turn with "typing…", a human-like pause and an occasional two-message split. */
  private async aiReply(eng: ArenaSessionEngine, ctx: Ctx): Promise<ArenaTurn | null> {
    if (eng.done || eng.session.status === "finished") {
      await this.send(ctx.chatId, ctx.t.sessionDone);
      return null;
    }
    if (eng.session.modes[eng.nextSide] === "human") return null;
    void this.adapter.typing(ctx.chatId);
    const t0 = Date.now();
    const turn = await eng.step();
    if (!turn) {
      if ((eng.session.status as string) === "finished" || eng.done) await this.send(ctx.chatId, ctx.t.sessionDone);
      return null;
    }
    await this.deliver(eng, turn, ctx, Date.now() - t0);
    return turn;
  }

  private async deliver(eng: ArenaSessionEngine, turn: ArenaTurn, ctx: Ctx, elapsed: number) {
    const sid = eng.session.id;
    const mine = turn.side === this.plays(eng);
    let text = turn.text;
    if (turn.side === "scammer" && !mine && !eng.session.turns.slice(0, turn.index).some((x) => x.side === "scammer"))
      text = `${ctx.t.persona(clip(eng.script.persona, 120))}\n${text}`;
    if (mine) text = `${ctx.t.aiTag} ${text}`; // AI playing the expert's side (/mode)
    else if (this.view(sid) === "observer" && turn.side === "scammer") text = `😈 ${text}`;
    const parts = maybeSplit(text, () => this.rand());
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const wait = typingDelayMs(part, this.scale, () => this.rand()) - (i === 0 ? elapsed : 0);
      await this.pause(ctx.chatId, Math.max(0, wait));
      const last = i === parts.length - 1;
      const buttons: Button[][] | undefined =
        last && turn.side === "bait"
          ? [
              [
                { text: "👍", payload: `a:${sid}:${turn.index}:g` },
                { text: "👎", payload: `a:${sid}:${turn.index}:b` },
                { text: "✏️", payload: `e:${sid}:${turn.index}` },
              ],
            ]
          : undefined;
      await this.send(ctx.chatId, { text: part, ...(buttons ? { buttons } : {}) });
    }
  }

  /** AI-vs-AI (mode "ai" / "observer"): one step per queue slot so /mode can interrupt. */
  private async autoplay(eng: ArenaSessionEngine, ctx: Ctx) {
    const sid = eng.session.id;
    const tok = (this.autoTok.get(sid) ?? 0) + 1;
    this.autoTok.set(sid, tok);
    for (let n = 0; ; n++) {
      if (this.stopping || this.autoTok.get(sid) !== tok) return;
      if (n >= AUTO_BATCH) {
        await this.send(ctx.chatId, { text: ctx.t.autoPaused, buttons: [[{ text: ctx.t.continue, payload: `go:${sid}` }]] });
        return;
      }
      const turn = await this.enqueue(ctx.chatId, async () => {
        if (this.autoTok.get(sid) !== tok || eng.session.status === "finished") return null;
        return this.aiReply(eng, ctx);
      });
      if (!turn) return;
    }
  }

  private async cmdWhisper(ctx: Ctx, text: string) {
    if (!text) return void (await this.send(ctx.chatId, ctx.t.whisperUsage));
    const { eng, gone } = await this.active(ctx.chatId);
    if (!eng) return void (await this.send(ctx.chatId, gone ? ctx.t.sessionGone : ctx.t.noSession));
    const side = this.plays(eng);
    const v = this.view(eng.session.id);
    const target: ArenaSide = v === "human" ? other(side) : v === "ai" ? side : "bait";
    eng.whisper(target, clip(text, 1000));
    await this.audit(ctx.user, "arena.whisper", eng.session.id, `im → ${target}`);
    const who = v === "ai" ? ctx.t.whisperOwn : target === "bait" ? ctx.t.whisperBait(baitName(eng.session.persona, ctx.lang)) : ctx.t.whisperScammer;
    await this.send(ctx.chatId, ctx.t.whispered(who));
  }

  private async cmdMode(ctx: Ctx) {
    const { eng, gone } = await this.active(ctx.chatId);
    if (!eng) return void (await this.send(ctx.chatId, gone ? ctx.t.sessionGone : ctx.t.noSession));
    await this.send(ctx.chatId, {
      text: ctx.t.modeAsk,
      buttons: [
        [
          { text: ctx.t.modeAi, payload: "md:a" },
          { text: ctx.t.modeHuman, payload: "md:h" },
          { text: ctx.t.modeObserver, payload: "md:o" },
        ],
      ],
    });
  }

  private async setMode(ctx: Ctx, b: ButtonPress, code: string) {
    const { eng, gone } = await this.active(ctx.chatId);
    if (!eng) return void (await this.send(ctx.chatId, gone ? ctx.t.sessionGone : ctx.t.noSession));
    const sid = eng.session.id;
    const side = this.plays(eng);
    const v = code === "a" ? "ai" : code === "o" ? "observer" : "human";
    this.autoTok.set(sid, (this.autoTok.get(sid) ?? 0) + 1); // stop any running autoplay
    eng.setMode(side, v === "human" ? "human" : "ai");
    this.state.update((d) => void (d.view[sid] = v));
    await this.audit(ctx.user, "arena.mode", sid, `im ${side}=${v}`);
    const label = v === "ai" ? ctx.t.modeAi : v === "observer" ? ctx.t.modeObserver : ctx.t.modeHuman;
    await this.adapter.editMessage(ctx.chatId, b.messageId, { text: ctx.t.modeSet(label) });
    if (v === "human") {
      if (eng.nextSide !== side) await this.aiReply(eng, ctx);
      return;
    }
    void this.autoplay(eng, ctx).catch((e) => this.log(`[im] autoplay: ${(e as Error).message}`));
  }

  private async cmdEnd(ctx: Ctx) {
    const { eng, gone } = await this.active(ctx.chatId);
    if (!eng) return void (await this.send(ctx.chatId, gone ? ctx.t.sessionGone : ctx.t.noSession));
    const sid = eng.session.id;
    this.autoTok.set(sid, (this.autoTok.get(sid) ?? 0) + 1);
    eng.finish();
    await this.deps.chats.clear(this.kind, ctx.chatId);
    await this.audit(ctx.user, "arena.end", sid);
    await this.send(ctx.chatId, {
      text: ctx.t.rateAsk,
      buttons: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n}`, payload: `rt:${sid}:${n}` }))],
    });
  }

  private async finishRating(ctx: Ctx, sid: string, score: number, note: string) {
    const s = await this.deps.arena.rate(sid, { expertId: ctx.user.id, score, note: note === "-" || note === "－" ? "" : note });
    await this.audit(ctx.user, "arena.rate", sid, `${score}`);
    await this.send(ctx.chatId, ctx.t.rated(score, s.turns.length, s.drafts.length));
  }

  private async cmdStatus(ctx: Ctx) {
    let used: number | undefined;
    let limit: number | undefined;
    try {
      ({ usedToday: used, limitPerDay: limit } = await this.deps.identity.quota(ctx.user.id));
    } catch (e) {
      this.log(`[im] quota() failed: ${(e as Error).message}`);
    }
    const { eng } = await this.active(ctx.chatId);
    const s = eng?.session;
    const v = s ? this.view(s.id) : undefined;
    await this.send(
      ctx.chatId,
      ctx.t.status({
        used,
        limit,
        title: eng?.script.title,
        plays: eng ? ctx.t.sideName[this.plays(eng)] : undefined,
        mode: v === "ai" ? ctx.t.modeAi : v === "observer" ? ctx.t.modeObserver : ctx.t.modeHuman,
        turns: s?.turns.length,
        engine: s?.engine,
        drafts: (s?.drafts ?? []).map((d) => `· ${d.chain}:${d.address} — ${ctx.t.review[d.review] ?? d.review}${d.alertId !== undefined ? ` #${d.alertId}` : ""}`),
      }),
    );
  }

  // ───────────────────────── arena events → expert / reviewers ─────────────────────────

  private async onArenaEvent(eng: ArenaSessionEngine, e: ArenaEvent) {
    const ch = eng.session.channel;
    if (!ch?.chatId || ch.kind !== this.kind) return;
    const lang = this.langFor(ch.ownerId);
    const t = T[lang];
    if (e.type === "draft") {
      const key = `${e.sessionId}:${e.draftIndex}`;
      const d = e.draft;
      if (!this.state.data.announced.includes(key)) {
        this.state.update((s) => void s.announced.push(key));
        if (d.review === "pending") {
          await this.send(ch.chatId, t.drafted(d.chain, d.address));
          const ctxTurn = [...eng.session.turns].reverse().find((x) => x.side === "scammer" && x.text.includes(d.address));
          const owner = this.names.get(ch.ownerId) ?? ch.ownerId;
          // D33: a warned draft gets no "on chain" button here; the reviewer confirms each warning in the web console
          const warned = !!d.warnings?.length;
          await this.pushCard(`d:${e.sessionId}:${e.draftIndex}`, (L) => ({
            text:
              T[L].cardAddress({ who: owner, title: eng.script.title, chain: d.chain, addr: d.address, context: clip(ctxTurn?.text ?? "", 200), source: L === "zh" ? "对练" : "arena" }) +
              (warned ? `\n${T[L].cardWarnings(d.warnings!.map((w) => w.detail))}` : ""),
            buttons: [[...(warned ? [] : [{ text: T[L].approveChain, payload: `d:${e.sessionId}:${e.draftIndex}:1` }]), { text: T[L].reject, payload: `d:${e.sessionId}:${e.draftIndex}:0` }]],
          }));
        } else if (d.filteredReason) {
          await this.send(ch.chatId, t.filtered(d.chain, d.address, d.filteredReason));
        }
        return;
      }
      if (d.review === "rejected") {
        await this.send(ch.chatId, t.draftRejected(d.address));
        if (!this.reviewing.has(`d:${key}`)) await this.closeCards(`d:${key}`, (L) => T[L].verdictRejected, "web");
      }
      return;
    }
    if (e.type === "safety" && e.rule === "llm-quota-exceeded") {
      // the engine charged the owner's quota per LLM call and has switched itself to rules (setEngine)
      if (this.state.data.downgraded.includes(e.sessionId)) return;
      this.state.update((s) => void s.downgraded.push(e.sessionId));
      try {
        await this.deps.identity.audit({ expertId: ch.ownerId, action: "im.quota.downgrade", target: e.sessionId });
      } catch {
        /* best effort */
      }
      await this.send(ch.chatId, t.quotaOut);
      return;
    }
    if (e.type === "onchain") {
      const d = eng.session.drafts[e.draftIndex];
      await this.send(ch.chatId, t.onchain(d?.address ?? "?", e.alertId));
      const key = `d:${e.sessionId}:${e.draftIndex}`;
      if (!this.reviewing.has(key)) await this.closeCards(key, (L) => T[L].verdictOnchain(e.alertId, e.txHash), "web");
    }
  }

  /** Send a review card to every bound reviewer and remember where it went. */
  private async pushCard(key: string, render: (l: Lang) => OutMessage) {
    let revs: Awaited<ReturnType<ImDeps["identity"]["reviewers"]>> = [];
    try {
      revs = await this.deps.identity.reviewers(this.kind);
    } catch (e) {
      this.log(`[im] reviewers() failed: ${(e as Error).message}`);
    }
    const sent: { chatId: string; messageId: string; text: string }[] = [];
    for (const r of revs) {
      const chatId = this.state.data.userChat[r.user.id] ?? r.externalId; // Telegram private chat id == user id
      const m = render(this.langFor(r.user.id));
      try {
        const { messageId } = await this.send(chatId, m);
        sent.push({ chatId, messageId, text: m.text });
      } catch (e) {
        this.log(`[im] card to reviewer ${r.user.id} failed: ${(e as Error).message}`);
      }
    }
    this.state.update((d) => void (d.cards[key] = sent));
  }

  /** Mark every copy of a card as handled (text + verdict, buttons removed). */
  private async closeCards(key: string, verdict: (l: Lang) => string, by: string) {
    const copies = this.state.data.cards[key];
    if (!copies) return;
    this.state.update((d) => void delete d.cards[key]);
    for (const c of copies) {
      const lang = Object.entries(this.state.data.userChat).find(([, chat]) => chat === c.chatId)?.[0];
      const L = lang ? this.langFor(lang) : "zh";
      try {
        await this.adapter.editMessage(c.chatId, c.messageId, { text: c.text + T[L].cardDone(verdict(L), by) });
      } catch (e) {
        this.log(`[im] card edit failed: ${(e as Error).message}`);
      }
    }
  }

  // ───────────────────────── buttons ─────────────────────────

  async onButton(b: ButtonPress) {
    let answered = false;
    const answer = async (toast?: string, alert = false) => {
      if (answered) return;
      answered = true;
      await this.adapter.answerButton(b.pressId, toast, alert);
    };
    try {
      const user = await this.deps.identity.userByBinding(this.kind, b.user.externalId);
      if (!user) return await answer(); // whitelist: silent
      this.names.set(user.id, user.name); // chat mapping is learned from messages only
      const lang = langOf(b.user.langCode);
      const ctx: Ctx = { chatId: b.chatId, user, lang, t: T[lang] };
      const parts = b.payload.split(":");
      const op = parts[0];
      switch (op) {
        case "n":
          await answer();
          return await this.enqueue(b.chatId, () => this.wizard(ctx, b, parts));
        case "md":
          await answer();
          return await this.enqueue(b.chatId, () => this.setMode(ctx, b, parts[1]!));
        case "go": {
          await answer();
          await this.adapter.editButtons(b.chatId, b.messageId, null);
          const { eng } = await this.active(b.chatId);
          if (eng && eng.session.id === parts[1] && this.view(eng.session.id) !== "human") void this.autoplay(eng, ctx);
          return;
        }
        case "a":
          return await this.annotate(ctx, b, parts, answer);
        case "e":
          return await this.askEdit(ctx, b, parts, answer);
        case "st":
          return await this.star(ctx, b, parts, answer);
        case "rt":
          return await this.rate(ctx, b, parts, answer);
        case "cr":
          return await this.reviewCorrection(ctx, parts, answer);
        case "d":
          return await this.reviewArenaDraft(ctx, parts, answer);
        case "ud":
          return await this.reviewUploadDraft(ctx, parts, answer);
        case "up":
          return await this.confirmUpload(ctx, b, parts, answer);
        case "sv":
          return await this.saveScript(ctx, b, parts, answer);
        default:
          return await answer();
      }
    } catch (e) {
      this.log(`[im] button ${b.payload.split(":")[0]} failed: ${(e as Error)?.stack ?? e}`);
      await answer(T[langOf(b.user.langCode)].error).catch(() => {});
    } finally {
      await answer().catch(() => {});
    }
  }

  private sessionById(sid: string) {
    return this.deps.arena.get(sid)?.session ?? this.deps.arena.list().find((s) => s.id === sid);
  }

  /** Session owner (or a reviewer) may act on its turns. */
  private canTouch(user: User, sid: string) {
    const s = this.sessionById(sid);
    if (!s) return undefined;
    return s.channel?.ownerId === user.id || user.role === "reviewer" ? s : undefined;
  }

  private async annotate(ctx: Ctx, b: ButtonPress, parts: string[], answer: (t?: string) => Promise<void>) {
    const [, sid, ti, r] = parts;
    const s = this.canTouch(ctx.user, sid!);
    if (!s) return answer(ctx.t.notYours);
    const turnIndex = Number(ti);
    if (s.turns[turnIndex]?.side !== "bait") return answer();
    const rating = r === "g" ? "good" : "bad";
    this.deps.training.addAnnotation({ sessionId: sid!, turnIndex, expertId: ctx.user.id, rating, tags: [], note: "" });
    await this.audit(ctx.user, "training.annotate", `${sid}#${turnIndex}`, rating);
    await answer(ctx.t.annotated(rating));
    await this.adapter
      .editButtons(b.chatId, b.messageId, [
        [
          { text: rating === "good" ? "👍✓" : "👍", payload: `a:${sid}:${turnIndex}:g` },
          { text: rating === "bad" ? "👎✓" : "👎", payload: `a:${sid}:${turnIndex}:b` },
          { text: "✏️", payload: `e:${sid}:${turnIndex}` },
        ],
      ])
      .catch(() => {});
  }

  private async askEdit(ctx: Ctx, b: ButtonPress, parts: string[], answer: (t?: string) => Promise<void>) {
    const [, sid, ti] = parts;
    const s = this.canTouch(ctx.user, sid!);
    if (!s) return answer(ctx.t.notYours);
    await answer();
    const { messageId } = await this.send(b.chatId, { text: ctx.t.editAsk, forceReply: { placeholder: ctx.t.editPlaceholder }, replyToMessageId: b.messageId });
    this.state.update((d) => void (d.pending[b.chatId] = { kind: "edit", sessionId: sid!, turnIndex: Number(ti), promptId: messageId, at: this.now().toISOString() }));
  }

  /** Context for a correction: the scammer line right before `turnIndex`, and its stage. */
  private async correctionBase(sid: string, turnIndex: number) {
    const live = this.deps.arena.get(sid);
    const s = live?.session ?? this.sessionById(sid);
    if (!s) return undefined;
    const script = live?.script ?? (await this.deps.arena.scripts()).find((x) => x.id === s.scriptId);
    if (!script) return undefined;
    const prev = [...s.turns.slice(0, turnIndex)].reverse().find((x) => x.side === "scammer");
    const stage = prev && live ? (live.metrics.stageByTurn[prev.index] ?? 0) : 0;
    return { s, script, prev, stage, turn: s.turns[turnIndex] };
  }

  private async fileCorrection(ctx: Ctx, sid: string, turnIndex: number, goodReply: string) {
    const base = await this.correctionBase(sid, turnIndex);
    if (!base?.turn || base.turn.side !== "bait") return void (await this.send(ctx.chatId, ctx.t.sessionGone));
    const c = this.deps.training.addCorrection({
      sessionId: sid,
      turnIndex,
      expertId: ctx.user.id,
      scriptId: base.script.id,
      scamType: base.script.type,
      stage: base.stage,
      situation: clip(base.prev?.text ?? "-", 1000),
      badReply: base.turn.text,
      goodReply,
      rationale: "",
      tags: [],
    });
    await this.audit(ctx.user, "training.correction", c.id, `${sid}#${turnIndex}`);
    await this.send(ctx.chatId, ctx.t.corrected);
    await this.pushCorrectionCard(c.id, ctx.user, base.script.title, c.situation, c.badReply, c.goodReply, false);
  }

  private async pushCorrectionCard(id: string, who: User, title: string, situation: string, bad: string, good: string, star: boolean) {
    await this.pushCard(`cr:${id}`, (L) => ({
      text: T[L].cardCorrection({ who: who.name, title, situation: clip(situation, 300), bad: clip(bad, 500), good: clip(good, 500), star }),
      buttons: [[{ text: T[L].approve, payload: `cr:${id}:1` }, { text: T[L].reject, payload: `cr:${id}:0` }]],
    }));
  }

  /** ⭐ on the expert's own decoy line → pending Correction with empty badReply (good-reply candidate). */
  private async star(ctx: Ctx, b: ButtonPress, parts: string[], answer: (t?: string) => Promise<void>) {
    const [, sid, ti] = parts;
    if (!this.canTouch(ctx.user, sid!)) return answer(ctx.t.notYours);
    const turnIndex = Number(ti);
    const base = await this.correctionBase(sid!, turnIndex);
    // D15: only the decoy side is ever learned from
    if (!base?.turn || base.turn.side !== "bait" || base.turn.author !== "human") return answer();
    const input = {
      sessionId: sid!,
      turnIndex,
      expertId: ctx.user.id,
      scriptId: base.script.id,
      scamType: base.script.type,
      stage: base.stage,
      situation: clip(base.prev?.text ?? "-", 1000),
      badReply: "",
      goodReply: base.turn.text,
      rationale: ctx.lang === "zh" ? "专家扮诱饵时的示范回复（⭐）" : "Expert's own decoy line (⭐)",
      tags: ["expert-demo"],
    };
    // empty badReply = a demonstration entry (training accepts it since 11/9)
    const c = this.deps.training.addCorrection(input);
    await this.audit(ctx.user, "training.correction", c.id, `star ${sid}#${turnIndex}`);
    await answer(ctx.t.starred);
    await this.adapter.editMessage(b.chatId, b.messageId, { text: ctx.t.starred }).catch(() => {});
    await this.pushCorrectionCard(c.id, ctx.user, base.script.title, c.situation, "", c.goodReply, true);
  }

  private async rate(ctx: Ctx, b: ButtonPress, parts: string[], answer: (t?: string) => Promise<void>) {
    const [, sid, n] = parts;
    const s = this.sessionById(sid!);
    if (!s || s.channel?.ownerId !== ctx.user.id) return answer(ctx.t.notYours);
    await answer();
    await this.adapter.editMessage(b.chatId, b.messageId, { text: `${ctx.t.rateAsk} ${"★".repeat(Number(n))}` }).catch(() => {});
    const { messageId } = await this.send(b.chatId, { text: ctx.t.noteAsk, forceReply: { placeholder: "-" } });
    this.state.update((d) => void (d.pending[b.chatId] = { kind: "note", sessionId: sid!, score: Number(n), promptId: messageId, at: this.now().toISOString() }));
  }

  private async reviewCorrection(ctx: Ctx, parts: string[], answer: (t?: string, alert?: boolean) => Promise<void>) {
    const [, id, a] = parts;
    if (ctx.user.role !== "reviewer") {
      await this.audit(ctx.user, "im.denied", `cr:${id}`);
      return answer(ctx.t.waitReviewer, true);
    }
    const approve = a === "1";
    const key = `cr:${id}`;
    let r;
    try {
      r = this.deps.training.reviewCorrection(id!, approve, ctx.user.id);
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (st === 409 || st === 404) {
        await this.closeCards(key, () => ctx.t.alreadyDone, "-");
        return answer(ctx.t.alreadyDone);
      }
      throw e;
    }
    await this.audit(ctx.user, "training.review", id, approve ? "approve" : "reject");
    await answer(approve ? ctx.t.verdictApproved : ctx.t.verdictRejected);
    await this.closeCards(key, (L) => (approve ? `${T[L].verdictApproved} · v${r.playbookVersion}` : T[L].verdictRejected), ctx.user.name);
    const expertChat = this.state.data.userChat[r.correction.expertId];
    if (expertChat && r.correction.expertId !== ctx.user.id) {
      const t = T[this.langFor(r.correction.expertId)];
      await this.send(expertChat, approve ? t.corrApproved(r.playbookVersion) : t.corrRejected).catch(() => {});
    }
  }

  private async reviewArenaDraft(ctx: Ctx, parts: string[], answer: (t?: string, alert?: boolean) => Promise<void>) {
    const [, sid, idx, a] = parts;
    if (ctx.user.role !== "reviewer") {
      await this.audit(ctx.user, "im.denied", `d:${sid}:${idx}`);
      return answer(ctx.t.waitReviewer, true);
    }
    const key = `d:${sid}:${idx}`;
    let eng = this.deps.arena.get(sid!);
    if (!eng) {
      await this.deps.arena.restore().catch(() => 0);
      eng = this.deps.arena.get(sid!);
    }
    if (!eng) return answer(ctx.t.notLive, true);
    this.subscribe(eng);
    const approve = a === "1";
    this.reviewing.add(key);
    try {
      const d = await eng.review(Number(idx), approve, ctx.user.name);
      await this.audit(ctx.user, "alert.review", `${d.chain}:${d.address}`, approve ? `alert #${d.alertId ?? "-"}` : "reject");
      const verdict = (L: Lang) => (d.review === "approved" && d.alertId !== undefined ? T[L].verdictOnchain(d.alertId, d.txHash) : d.filteredReason ? T[L].verdictFiltered(d.filteredReason) : T[L].verdictRejected);
      await answer(verdict(ctx.lang));
      await this.closeCards(key, verdict, ctx.user.name);
    } catch (e) {
      if ((e as { code?: string }).code === "warnings-unconfirmed") return answer(ctx.t.warnedUseWeb, true);
      if (/already/.test((e as Error).message)) {
        await this.closeCards(key, () => ctx.t.alreadyDone, "-");
        return answer(ctx.t.alreadyDone);
      }
      throw e;
    } finally {
      this.reviewing.delete(key);
    }
  }

  private async reviewUploadDraft(ctx: Ctx, parts: string[], answer: (t?: string, alert?: boolean) => Promise<void>) {
    const [, aid, idx, a] = parts;
    if (ctx.user.role !== "reviewer") {
      await this.audit(ctx.user, "im.denied", `ud:${aid}:${idx}`);
      return answer(ctx.t.waitReviewer, true);
    }
    if (!this.deps.scriptlab.reviewDraft) return answer(ctx.t.noReviewDraft, true);
    const key = `ud:${aid}:${idx}`;
    const approve = a === "1";
    try {
      const d = await this.deps.scriptlab.reviewDraft(aid!, Number(idx), approve, ctx.user.id);
      await this.audit(ctx.user, "alert.review", key, approve ? `alert #${d.alertId ?? "-"}` : "reject");
      const verdict = (L: Lang) => (d.review === "approved" && d.alertId !== undefined ? T[L].verdictOnchain(d.alertId, d.txHash) : d.filteredReason ? T[L].verdictFiltered(d.filteredReason) : T[L].verdictRejected);
      await answer(verdict(ctx.lang));
      await this.closeCards(key, verdict, ctx.user.name);
      const uploader = this.state.data.uploads[aid!];
      const chat = uploader && uploader !== ctx.user.id ? this.state.data.userChat[uploader] : undefined;
      if (chat && d.review === "approved" && d.alertId !== undefined) await this.send(chat, T[this.langFor(uploader!)].onchain(d.address ?? "", d.alertId)).catch(() => {});
    } catch (e) {
      const st = (e as { status?: number }).status;
      if ((e as { code?: string }).code === "warnings-unconfirmed") return answer(ctx.t.warnedUseWeb, true);
      if (st === 409) {
        await this.closeCards(key, () => ctx.t.alreadyDone, "-");
        return answer(ctx.t.alreadyDone);
      }
      throw e;
    }
  }

  // ───────────────────────── uploads ─────────────────────────

  private async handleUpload(ctx: Ctx, m: InMessage) {
    if (m.file && !TEXT_EXT.test(m.file.filename) && !IMAGE_EXT.test(m.file.filename)) return void (await this.send(ctx.chatId, ctx.t.unsupportedFile));
    const day = shanghai(this.now()).day;
    if (this.state.data.privacy[ctx.user.id] !== day) {
      // contract §5: once per user per day, before the first upload is analyzed
      this.state.update((d) => void (d.privacy[ctx.user.id] = day));
      const key = randomBytes(5).toString("hex");
      this.pendingUploads.set(key, { userId: ctx.user.id, chatId: ctx.chatId, msg: m, at: Date.now() });
      await this.send(ctx.chatId, {
        text: ctx.t.privacy,
        buttons: [[{ text: ctx.t.privacyGo, payload: `up:${key}:1` }, { text: ctx.t.privacyCancel, payload: `up:${key}:0` }]],
      });
      return;
    }
    await this.analyze(ctx, m);
  }

  private async confirmUpload(ctx: Ctx, b: ButtonPress, parts: string[], answer: (t?: string) => Promise<void>) {
    const [, key, go] = parts;
    const p = this.pendingUploads.get(key!);
    await this.adapter.editButtons(b.chatId, b.messageId, null).catch(() => {});
    if (!p || p.userId !== ctx.user.id || Date.now() - p.at > PENDING_TTL_MS) return answer(ctx.t.uploadExpired);
    this.pendingUploads.delete(key!);
    await answer();
    if (go !== "1") return void (await this.send(b.chatId, ctx.t.uploadCancelled));
    await this.enqueue(b.chatId, () => this.analyze(ctx, p.msg));
  }

  private async analyze(ctx: Ctx, m: InMessage) {
    const refs = m.images?.length ? m.images : m.file ? [m.file] : [];
    const images = refs.filter((r) => r.kind === "image" || IMAGE_EXT.test(r.filename)).length;
    if (images && !(await this.deps.identity.consumeLlmQuota(ctx.user.id))) return void (await this.send(ctx.chatId, ctx.t.quotaUpload));
    await this.send(ctx.chatId, ctx.t.analyzing(refs.length));
    void this.adapter.typing(ctx.chatId);
    const files = await Promise.all(refs.map((r) => this.adapter.fetchFile(r)));
    const enc = files.map((f) => {
      const text = TEXT_EXT.test(f.filename) && !f.mime?.startsWith("image/");
      return { filename: f.filename, content: text ? f.data.toString("utf8") : f.data.toString("base64"), encoding: (text ? "utf8" : "base64") as "utf8" | "base64" };
    });
    const upload: ScriptUpload =
      enc.length === 1
        ? { ...enc[0]!, expertId: ctx.user.id }
        : { filename: enc[0]!.filename, content: "", encoding: "utf8", expertId: ctx.user.id, files: enc };
    let a;
    try {
      a = await this.deps.scriptlab.analyzeUpload(upload);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "image-offline") return void (await this.send(ctx.chatId, ctx.t.imageOffline));
      return void (await this.send(ctx.chatId, ctx.t.uploadFailed(clip(err.message ?? String(e), 300))));
    }
    this.state.update((d) => void (d.uploads[a.id] = ctx.user.id));
    await this.audit(ctx.user, "scripts.upload", a.id, `${a.format} ${refs.length} file(s)`);
    const live = a.alertDrafts.map((d, i) => ({ d, i })).filter(({ d }) => !d.filteredReason);
    const piiTotal = a.pii.reduce((n, p) => n + p.count, 0);
    const text =
      ctx.t.analysis({
        type: TYPE_LABEL[a.scamType.value]?.[ctx.lang] ?? a.scamType.value,
        conf: Math.round(a.scamType.confidence * 100),
        stages: a.stages.map((s) => s.name).join(" → "),
        addrs: a.alertDrafts.map((d) => `${d.chain}:${d.address}${d.filteredReason ? " ⚠" : ""}`),
        pii: piiTotal,
        piiDetail: a.pii.map((p) => `${piiLabel(p.kind, ctx.lang)} ${p.count}`).join(ctx.lang === "zh" ? "，" : ", "),
        engine: a.engine,
        warnings: a.warnings.slice(0, 2),
      }) + (live.length ? `\n${ctx.t.uploadDrafts(live.length)}` : "");
    await this.send(ctx.chatId, { text, buttons: [[{ text: ctx.t.saveBtn, payload: `sv:${a.id}` }]] });
    for (const { d, i } of live) {
      const warned = !!d.warnings?.length;
      await this.pushCard(`ud:${a.id}:${i}`, (L) => ({
        text:
          T[L].cardAddress({ who: ctx.user.name, title: a.filename, chain: d.chain, addr: d.address, context: "", source: L === "zh" ? "上传" : "upload" }) +
          (warned ? `\n${T[L].cardWarnings(d.warnings!.map((w) => w.detail))}` : ""),
        buttons: [[...(warned ? [] : [{ text: T[L].approveChain, payload: `ud:${a.id}:${i}:1` }]), { text: T[L].reject, payload: `ud:${a.id}:${i}:0` }]],
      }));
    }
  }

  private async saveScript(ctx: Ctx, b: ButtonPress, parts: string[], answer: (t?: string) => Promise<void>) {
    const aid = parts[1]!;
    const owner = this.state.data.uploads[aid];
    if (owner !== ctx.user.id && ctx.user.role !== "reviewer") return answer(ctx.t.notYours);
    await answer();
    try {
      const def = await this.deps.scriptlab.save(aid, { expertId: ctx.user.id });
      await this.audit(ctx.user, "scripts.save", def.id, aid);
      await this.adapter.editButtons(b.chatId, b.messageId, null).catch(() => {});
      await this.send(b.chatId, ctx.t.saved(def.title));
    } catch (e) {
      await this.send(b.chatId, ctx.t.saveFailed(clip((e as Error).message, 300)));
    }
  }

  // ───────────────────────── daily digest (09:00 Asia/Shanghai) ─────────────────────────

  async runDigestIfDue(now = this.now()): Promise<boolean> {
    const { day, hour } = shanghai(now);
    if (hour < 9 || hour >= 12 || this.state.data.digestDay === day) return false;
    this.state.update((d) => void (d.digestDay = day));
    const since = now.getTime() - 24 * 3600_000;
    const tr = this.deps.training;
    const corr = (tr.listCorrections?.() ?? []) as { at: string; review: string }[];
    const sessions = this.deps.arena.list();
    const drafts = sessions.flatMap((s) => s.drafts.map((d) => ({ d, recent: s.turns.some((x) => Date.parse(x.ts) >= since) })));
    const run = tr.listEvalRuns?.().at(-1);
    const regression = run && run.summary.regressionTotal ? `${run.summary.regressionPassed}/${run.summary.regressionTotal}（${Math.round((100 * run.summary.regressionPassed) / run.summary.regressionTotal)}%）` : undefined;
    const revs = await this.deps.identity.reviewers(this.kind);
    for (const r of revs) {
      const L = this.langFor(r.user.id);
      const text = T[L].digest({
        corrections: corr.filter((c) => Date.parse(c.at) >= since).length,
        pendingCorr: corr.filter((c) => c.review === "pending").length,
        addrs: drafts.filter((x) => x.recent && !x.d.filteredReason).length,
        pendingAddr: drafts.filter((x) => x.d.review === "pending").length,
        regression: regression && L === "en" ? regression.replace("（", " (").replace("）", ")") : regression,
        console: `${this.deps.publicUrl.replace(/\/+$/, "")}/#/training`,
      });
      await this.send(this.state.data.userChat[r.user.id] ?? r.externalId, text).catch((e) => this.log(`[im] digest to ${r.user.id}: ${(e as Error).message}`));
    }
    return true;
  }
}

