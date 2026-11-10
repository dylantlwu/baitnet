import type {
  AttestationResult,
  Annotation,
  ArenaSession,
  ArenaSide,
  ArenaTurn,
  Correction,
  EvalReport,
  EvalRun,
  PlaybookEntry,
  ScamScriptDef,
  ScriptAnalysis,
  SideMode,
} from "@baitnet/shared";
import { ARENA_MODELS, DEFAULT_ARENA_MODEL } from "@baitnet/shared";
import { tokenize } from "../lib/tokens";
import { analyzeUpload } from "../scriptlab/analyze";
import { normalizeScripts } from "./normalize";
import { ReadOnlyError, type ArenaStreamEvent, type Backend } from "./types";

export interface MockSeed {
  scripts: ScamScriptDef[];
  attestation?: AttestationResult;
  sessions?: ArenaSession[];
  corrections?: Correction[];
  playbook?: PlaybookEntry[];
  eval?: EvalReport;
  evalRuns?: EvalRun[];
}

const INJECTION_RE = /(ignore|override|seed phrase|recovery phrase|private key|mnemonic|助记词|私钥|忽略)/i;

/** Rules-engine bait lines (mirrors the server's template engine; fictional persona only). */
const BAIT_LINES: Record<"zh" | "en", Record<string, string[]>> = {
  en: {
    open: ["Hi, who is this? I don't think we've talked before.", "Oh hello. Sorry, how did you get my number?"],
    stall: [
      "That sounds interesting, but I'm a bit nervous. Can you explain it once more, slowly?",
      "Let me think about it. My son usually helps me with these apps.",
      "I need to check my balance first, the banking app is so slow today.",
    ],
    ask: [
      "OK, suppose I want to try. Where exactly do I send it? Which network?",
      "Can you write the address again? I want to copy it correctly. Is it Ethereum or Tron?",
      "Is there a website where I can see my account after I pay?",
    ],
    confirm: [
      "Just to be sure I copy it right, the address starts with {head}? And it's on {chain}?",
      "Got it. I'll do it after work. Is that the same address for everyone?",
    ],
    refuse: [
      "Sorry, I don't share recovery words or keys with anyone, my bank told me never to. Is there another way to pay?",
      "I won't sign anything I don't understand. Just tell me the address and I'll transfer from my app.",
    ],
  },
  zh: {
    open: ["你好，请问你是哪位？我们之前聊过吗？", "哦你好，不好意思，你怎么有我的号码？"],
    stall: ["听着挺好的，但我有点担心，你能再慢慢跟我讲一遍吗？", "我考虑一下，这些软件平时都是我儿子帮我弄的。", "我先看看卡里还有多少钱，银行 App 今天特别卡。"],
    ask: ["好吧，假如我想试试，具体转到哪个地址？走哪条链？", "你能把地址再发一遍吗？我怕抄错。是以太坊还是波场？", "付完款之后有网站能看到我的账户吗？"],
    confirm: ["我确认一下，地址是 {head} 开头的对吧？是 {chain} 链？", "知道了，我下班后转。这个地址是大家都用的吗？"],
    refuse: ["不好意思，助记词和私钥我谁都不给，银行说过千万不能给。有别的付款方式吗？", "看不懂的东西我不签。你直接告诉我地址，我从自己的 App 转。"],
  },
};

const pick = <T>(a: T[], i: number) => a[i % a.length];
/** Used when a script has no sample lines (e.g. catalog-only entries from a snapshot). */
const GENERIC_SCAMMER: Record<"zh" | "en", string[]> = {
  zh: ["你好，最近有个稳赚的机会，想了解一下吗？", "很多人都已经赚到了，你先小额试试。", "名额有限，今晚之前要定下来。"],
  en: ["Hi! There's a low-risk opportunity I think you'd like. Interested?", "Lots of people already made money, start small.", "Spots are limited, please decide tonight."],
};
const rid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeTx = () => Array.from({ length: 44 }, () => b58[Math.floor(Math.random() * 58)]).join("");

interface Live {
  session: ArenaSession;
  script: ScamScriptDef;
  listeners: Set<(e: ArenaStreamEvent) => void>;
  timer?: ReturnType<typeof setTimeout>;
  /** auto reply after a human line (one at a time, like the server's queue) */
  replyTimer?: ReturnType<typeof setTimeout>;
  whispers: Partial<Record<ArenaSide, string>>;
  scammerStep: number;
  injected: boolean;
}

export function createMockBackend(seed: MockSeed, opts: { readOnly?: boolean; tickMs?: number } = {}): Backend {
  const readOnly = !!opts.readOnly;
  const tickMs = opts.tickMs ?? 1300;
  // Snapshot catalogs only carry id/type/lang/title: normalise so missing stages never crash the engine.
  const scripts = normalizeScripts(seed.scripts);
  const sessions = new Map<string, Live>();
  let corrections = [...(seed.corrections ?? [])];
  let playbook = [...(seed.playbook ?? [])];
  const annotations: Annotation[] = [];
  const analyses = new Map<string, ScriptAnalysis & { reviewed: Record<number, boolean> }>();
  let nextAlertId = 100;
  for (const rec of seed.sessions ?? []) {
    const script = scripts.find((x) => x.id === rec.scriptId) ?? normalizeScripts([{ id: rec.scriptId }])[0];
    sessions.set(rec.id, { session: JSON.parse(JSON.stringify(rec)), script, listeners: new Set(), whispers: {}, scammerStep: 0, injected: true });
  }
  const guard = () => {
    if (readOnly) throw new ReadOnlyError();
  };

  const emit = (l: Live, e: ArenaStreamEvent) => l.listeners.forEach((f) => f(e));
  const setStatus = (l: Live, status: ArenaSession["status"]) => {
    l.session.status = status;
    emit(l, { type: "status", sessionId: l.session.id, status });
  };

  function addTurn(l: Live, side: ArenaSide, text: string, author: "ai" | "human", extra: Partial<ArenaTurn> = {}): ArenaTurn {
    const turn: ArenaTurn = { index: l.session.turns.length, side, text, author, ts: new Date().toISOString(), ...extra };
    l.session.turns.push(turn);
    emit(l, { type: "turn", sessionId: l.session.id, turn });
    if (side === "scammer") extract(l, text);
    if (l.session.turns.length >= 24) {
      stop(l);
      setStatus(l, "finished");
    }
    return turn;
  }

  function extract(l: Live, text: string) {
    for (const tok of tokenize(text)) {
      if (tok.kind !== "address") continue;
      if (l.session.drafts.some((d) => d.address === tok.value)) continue;
      const poison = l.script.poison && l.script.poison.address.toLowerCase() === tok.value.toLowerCase() ? l.script.poison : undefined;
      const draft = {
        chain: tok.chain,
        address: tok.value,
        level: "L1" as const,
        category: l.script.type,
        evidenceHash: "",
        conversationId: l.session.id,
        filteredReason: poison ? poison.why : undefined,
        review: (poison ? "rejected" : "pending") as "pending" | "rejected",
      };
      l.session.drafts.push(draft);
      emit(l, { type: "draft", sessionId: l.session.id, draftIndex: l.session.drafts.length - 1, draft });
    }
  }

  function scammerLine(l: Live): string {
    const s = l.script;
    const scripted = [s.hook, ...s.stages.flatMap((st) => st.sampleLines)].filter((x) => x && x.trim());
    const lines = scripted.length ? scripted : GENERIC_SCAMMER[s.lang];
    // Plant artifacts once their stage is reached.
    const stageIdx = Math.max(0, Math.min(s.stages.length - 1, Math.floor(l.scammerStep / 2)));
    const due = s.plantedArtifacts.find((a) => a.revealAtStage <= stageIdx && !l.session.turns.some((t) => t.text.includes(a.value)));
    const lastBait = [...l.session.turns].reverse().find((t) => t.side === "bait")?.text ?? "";
    l.scammerStep++;
    if (!l.injected && l.scammerStep === 4 && s.injections.length) {
      l.injected = true;
      return s.injections[0];
    }
    if (due && (l.scammerStep > 2 || /address|地址|where|哪/.test(lastBait))) {
      const lead = s.lang === "zh" ? "转到这个地址：" : "Send it here: ";
      const poison = s.poison && due.kind === "address" ? s.poison.address : due.value;
      return `${lead}${poison}`;
    }
    return pick(lines, l.scammerStep - 1);
  }

  function baitLine(l: Live, i: number): { text: string; safety?: ArenaTurn["safety"]; whisper?: string } {
    const lang = l.script.lang;
    const T = BAIT_LINES[lang];
    const lastScam = [...l.session.turns].reverse().find((t) => t.side === "scammer")?.text ?? "";
    const whisper = l.session.modes.bait === "ai+whisper" ? l.whispers.bait : undefined;
    if (whisper) l.whispers.bait = undefined;
    if (INJECTION_RE.test(lastScam)) {
      // Simulate a naive draft that the safety filter rewrites.
      const original = lang === "zh" ? "好的，我的助记词是 apple river ……" : "OK, my recovery phrase is apple river ...";
      emit(l, { type: "safety", sessionId: l.session.id, side: "bait", rule: "seed-phrase" });
      return { text: pick(T.refuse, i), safety: { blocked: true, rule: "seed-phrase", original }, whisper };
    }
    const addr = tokenize(lastScam).find((t) => t.kind === "address");
    if (addr && addr.kind === "address")
      return { text: pick(T.confirm, i).replace("{head}", addr.value.slice(0, 6)).replace("{chain}", addr.chain.toUpperCase()), whisper };
    if (i === 0) return { text: pick(T.open, i), whisper };
    if (whisper) return { text: pick(T.ask, i), whisper };
    return { text: i % 2 ? pick(T.ask, i) : pick(T.stall, i), whisper };
  }

  function stepOnce(l: Live): boolean {
    if (l.session.status === "finished") return false;
    const last = l.session.turns[l.session.turns.length - 1];
    const side: ArenaSide = !last || last.side === "bait" ? "scammer" : "bait";
    if (l.session.modes[side] === "human") return false; // wait for say()
    if (side === "scammer") {
      const whisper = l.session.modes.scammer === "ai+whisper" ? l.whispers.scammer : undefined;
      l.whispers.scammer = undefined;
      addTurn(l, "scammer", scammerLine(l), "ai", whisper ? { whisper } : {});
    } else {
      const baitTurns = l.session.turns.filter((t) => t.side === "bait").length;
      const r = baitLine(l, baitTurns);
      addTurn(l, "bait", r.text, "ai", { ...(r.whisper ? { whisper: r.whisper } : {}), ...(r.safety ? { safety: r.safety } : {}) });
    }
    return true;
  }

  /** Same rule as the server: after a human line an AI other side answers once (never twice). */
  function autoReply(l: Live) {
    if (l.replyTimer || l.session.status === "finished") return;
    const last = l.session.turns[l.session.turns.length - 1];
    const side: ArenaSide = !last || last.side === "bait" ? "scammer" : "bait";
    if (l.session.modes[side] === "human") return;
    emit(l, { type: "typing", sessionId: l.session.id, side, on: true });
    l.replyTimer = setTimeout(() => {
      l.replyTimer = undefined;
      if (l.session.status !== "running") stepOnce(l);
      emit(l, { type: "typing", sessionId: l.session.id, side, on: false });
    }, Math.min(700, tickMs));
  }

  function stop(l: Live) {
    if (l.timer) clearTimeout(l.timer);
    l.timer = undefined;
  }
  function loop(l: Live) {
    stop(l);
    l.timer = setTimeout(() => {
      if (l.session.status !== "running") return;
      stepOnce(l);
      if (l.session.status === "running") loop(l);
    }, tickMs);
  }
  const live = (id: string) => {
    const l = sessions.get(id);
    if (!l) throw new Error(`unknown session ${id}`);
    return l;
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  return {
    kind: readOnly ? "replay" : "mock",
    readOnly,
    listScripts: async () => normalizeScripts(clone(scripts)),
    listModels: async () => ({ default: DEFAULT_ARENA_MODEL, liveLLM: false, models: ARENA_MODELS.map((m) => ({ ...m, price: { ...m.price }, available: false })) }),
    // Recorded + created sessions; seeded ones are registered so they can be reviewed too.
    listRecordedSessions: async () => clone([...sessions.values()].map((l) => l.session)),
    async getSession(id) {
      return clone(live(id).session);
    },
    async createSession(scriptId, modes, modelChoice = DEFAULT_ARENA_MODEL) {
      guard();
      const script = scripts.find((s) => s.id === scriptId);
      if (!script) throw new Error(`unknown script ${scriptId}`);
      // in-browser rules engine: the choice is recorded, no model runs (same as a server without a key)
      const session: ArenaSession = {
        id: rid("as"), scriptId, engine: "rules", modelChoice, modes: { ...modes }, status: "paused", turns: [], drafts: [], createdAt: new Date().toISOString(),
      };
      sessions.set(session.id, { session, script, listeners: new Set(), whispers: {}, scammerStep: 0, injected: false });
      return clone(session);
    },
    subscribe(id, onEvent) {
      const l = sessions.get(id);
      if (!l) return () => undefined;
      l.listeners.add(onEvent);
      return () => l.listeners.delete(onEvent);
    },
    async control(id, action) {
      guard();
      const l = live(id);
      if (action === "pause") {
        stop(l);
        setStatus(l, "paused");
      } else if (action === "step") {
        stop(l);
        if (l.session.status === "running") setStatus(l, "paused");
        stepOnce(l);
      } else {
        setStatus(l, "running");
        loop(l);
      }
    },
    async setMode(id, side, mode: SideMode) {
      guard();
      const l = live(id);
      l.session.modes[side] = mode;
      emit(l, { type: "mode", sessionId: id, side, mode });
      if (l.session.status === "running") loop(l);
    },
    async say(id, side, text) {
      guard();
      const l = live(id);
      const turn = addTurn(l, side, text, "human");
      if (l.session.status === "running") loop(l);
      else autoReply(l);
      return clone(turn);
    },
    async whisper(id, side, text) {
      guard();
      live(id).whispers[side] = text;
    },
    async review(id, draftIndex, approve) {
      guard();
      const l = live(id);
      const d = l.session.drafts[draftIndex];
      if (!d || d.filteredReason) return;
      if (!approve) {
        d.review = "rejected";
        emit(l, { type: "draft", sessionId: id, draftIndex, draft: { ...d } });
        return;
      }
      setTimeout(() => {
        d.review = "approved";
        d.alertId = nextAlertId++;
        d.txHash = fakeTx();
        emit(l, { type: "onchain", sessionId: id, draftIndex, alertId: d.alertId, txHash: d.txHash });
      }, 700);
    },
    async postAnnotation(a) {
      guard();
      const full: Annotation = { ...a, id: rid("ann"), at: new Date().toISOString() };
      annotations.push(full);
      return full;
    },
    async deleteAnnotation(id) {
      guard();
      const i = annotations.findIndex((a) => a.id === id);
      if (i < 0) throw new Error(`unknown annotation ${id}`);
      annotations.splice(i, 1);
    },
    async postCorrection(c) {
      guard();
      const full: Correction = { ...c, id: rid("cor"), at: new Date().toISOString(), review: "pending" };
      corrections = [full, ...corrections];
      return full;
    },
    listCorrections: async () => clone(corrections),
    async reviewCorrection(id, approve, reviewer) {
      guard();
      const c = corrections.find((x) => x.id === id);
      if (!c) throw new Error(`unknown correction ${id}`);
      c.review = approve ? "approved" : "rejected";
      c.reviewer = reviewer;
      if (approve) {
        const version = Math.max(0, ...playbook.map((p) => p.version)) + 1;
        playbook = [
          ...playbook,
          {
            id: rid("pb"), version, scamType: c.scamType, stage: c.stage, situation: c.situation, badReply: c.badReply,
            goodReply: c.goodReply, rationale: c.rationale, tags: c.tags, sourceCorrectionId: c.id,
          },
        ];
      }
      return clone(c);
    },
    getPlaybook: async () => clone(playbook),
    getEval: async () => (seed.eval ? clone(seed.eval) : undefined),
    getEvalRuns: async () => clone(seed.evalRuns ?? []),
    async upload(u, opts) {
      guard();
      if (opts?.ephemeral && (u.encoding === "base64" || /\.(png|jpe?g|webp|gif)$/i.test(u.filename))) throw new Error("ephemeral-image");
      const a = await analyzeUpload(u);
      if (opts?.ephemeral) {
        // Zero retention: nothing is kept; the attestation of the (recorded) TEE call travels with the result.
        const att = seed.attestation ? { ...seed.attestation, recorded: true } : undefined;
        return clone({ ...a, ephemeral: true as const, attestation: att });
      }
      analyses.set(a.id, { ...a, reviewed: {} });
      return clone(a);
    },
    async saveScript(id, draft, analysis) {
      guard();
      if (!analyses.has(id) && analysis?.ephemeral) {
        // Only now, after the user confirmed, does anything get stored.
        const { ephemeral: _e, attestation: _a, ...rest } = analysis;
        analyses.set(id, { ...rest, reviewed: {} });
      }
      if (!analyses.has(id)) throw new Error(`unknown analysis ${id}`);
      const i = scripts.findIndex((s) => s.id === draft.id);
      if (i >= 0) scripts[i] = draft;
      else scripts.push(draft);
      return clone(draft);
    },
    async reviewUploadDraft(id, idx, approve) {
      guard();
      const a = analyses.get(id);
      if (!a || !a.alertDrafts[idx]) throw new Error("unknown draft");
      a.reviewed[idx] = approve;
      return approve ? { alertId: nextAlertId++, txHash: fakeTx() } : {};
    },
  };
}
