import { randomBytes } from "node:crypto";
import type { AlertDraft, AnalysisEngine, Lang, ScamScriptDef, ScamType, ScriptAnalysis, ScriptUpload } from "@baitnet/shared";
import {
  KnownEntityFilter,
  canonicalJson,
  extractFromText,
  loadKnownEntities,
  sealEvidence,
  sha256Hex,
  type ExtractedAddress,
  type PublicEvidence,
} from "@baitnet/agent";
import { SCAM_TYPES, detectInjections, detectLang, inferTags, newId } from "@baitnet/training";
import { DOUBT_RE, SELF_INTRO_RE, STAGES, TAG_STAGE, TYPE_GOAL, TYPE_LABEL, TYPE_LEXICON } from "./lexicon.js";
import { parseUpload, ScriptLabError, type ParsedUpload } from "./parse.js";
import { Redactor, isRoleLabel } from "./redact.js";

export const MAX_TEXT_BYTES = 2_000_000;

export type Role = "scammer" | "victim";
export interface Line {
  role: Role;
  speaker?: string; // redacted placeholder or role label
  text: string; // redacted
  ts?: string;
}

/** Everything after parsing + redaction; nothing in here holds PII in clear except `redactor` (secrets). */
export interface Prepared {
  id: string;
  upload: Pick<ScriptUpload, "filename" | "expertId" | "langHint" | "encoding">;
  format: ParsedUpload["format"];
  lang: Lang; // language of the uploaded material
  /** language of generated text (draft templates, stage names, warnings, role labels): zh material → always zh */
  outLang: Lang;
  lines: Line[];
  redactedText: string;
  redactor: Redactor;
  script?: ScamScriptDef; // redacted, for scam-script-json
  original: string; // raw upload content → encrypted evidence only
  notes: string[];
}

// ───────────────────────── prepare: parse → roles → redact ─────────────────────────

function speakerScore(texts: string[]): number {
  let s = 0;
  for (const t of texts) {
    s += inferTags(t).length;
    const ex = extractFromText(t);
    s += 3 * (ex.addresses.length + ex.urls.length);
    s += 3 * detectInjections(t).length;
  }
  return s / Math.max(1, Math.sqrt(texts.length));
}

function assignRoles(parsed: ParsedUpload): Map<string, Role> {
  const by = new Map<string, string[]>();
  for (const m of parsed.messages) if (m.speaker) by.set(m.speaker, [...(by.get(m.speaker) ?? []), m.text]);
  const roles = new Map<string, Role>();
  for (const sp of by.keys()) {
    if (/骗子|scammer|诈骗/i.test(sp)) roles.set(sp, "scammer");
    else if (/^(受害者|victim|我|me|本人)$/i.test(sp)) roles.set(sp, "victim");
  }
  if (!roles.size || ![...roles.values()].includes("scammer")) {
    let best: string | undefined;
    let bestScore = -1;
    for (const [sp, texts] of by) {
      if (roles.get(sp) === "victim") continue;
      const sc = speakerScore(texts);
      if (sc > bestScore) [best, bestScore] = [sp, sc];
    }
    if (best) roles.set(best, "scammer");
  }
  for (const sp of by.keys()) if (!roles.has(sp)) roles.set(sp, "victim");
  return roles;
}

export function redactScript(s: ScamScriptDef, r: Redactor): ScamScriptDef {
  const red = (x: string) => r.redact(x);
  return {
    ...s,
    title: red(s.title ?? ""),
    persona: red(s.persona ?? ""),
    hook: red(s.hook ?? ""),
    goal: red(s.goal ?? ""),
    stages: (s.stages ?? []).map((st) => ({ name: red(st.name ?? ""), objective: red(st.objective ?? ""), sampleLines: (st.sampleLines ?? []).map(red) })),
    objections: (s.objections ?? []).map((o) => ({ victimSays: red(o.victimSays ?? ""), scammerCounters: (o.scammerCounters ?? []).map(red) })),
    injections: (s.injections ?? []).map(red),
    // planted phones/handles are PII-shaped → placeholders; addresses/urls are kept
    plantedArtifacts: (s.plantedArtifacts ?? []).map((a) => (a.kind === "phone" || a.kind === "handle" ? { ...a, value: red(a.value) } : a)),
  };
}

export function prepareText(upload: ScriptUpload, parsed: ParsedUpload, originalOverride?: string, requestedLang?: Lang): Prepared {
  const roles = assignRoles(parsed);
  const allText = parsed.messages.map((m) => m.text).join("\n");
  const lang: Lang = upload.langHint ?? detectLang(allText);
  const outLang: Lang = resolveOutLang(lang, requestedLang);
  const redactor = new Redactor();
  for (const sp of roles.keys()) redactor.addName(sp);
  redactor.collectNames(allText);
  const label = (role: Role) => (outLang === "zh" ? (role === "scammer" ? "骗子" : "受害者") : role);
  const noSpeakers = !parsed.messages.some((m) => m.speaker);
  const lines: Line[] = parsed.messages.map((m) => {
    const role: Role = m.speaker ? roles.get(m.speaker)! : "scammer";
    const sp = m.speaker && !isRoleLabel(m.speaker) ? redactor.redact(m.speaker) : undefined;
    return { role, speaker: sp, text: redactor.redact(m.text.replace(/\n+/g, " ")), ts: m.ts };
  });
  const redactedText = lines
    .map((l) => {
      if (noSpeakers) return l.text;
      const who = l.speaker ? (outLang === "zh" ? `${l.speaker}（${label(l.role)}）` : `${l.speaker} (${label(l.role)})`) : label(l.role);
      return `${who}${outLang === "zh" ? "：" : ": "}${l.text}`;
    })
    .join("\n");
  const script = parsed.script ? redactScript(parsed.script, redactor) : undefined;
  return {
    id: newId("sla"),
    upload: { filename: upload.filename, expertId: upload.expertId, langHint: upload.langHint, encoding: upload.encoding },
    format: parsed.format,
    lang,
    outLang,
    lines,
    redactedText,
    redactor,
    script,
    original: originalOverride ?? upload.content,
    notes: parsed.notes,
  };
}

// ───────────────────────── evidence (reuses M2 AES-256-GCM sealing) ─────────────────────────

export function sealUploadEvidence(p: Prepared, addresses: ExtractedAddress[], urls: string[]): string {
  const salt = randomBytes(16).toString("hex");
  const secrets = p.redactor.secrets();
  const createdAt = new Date().toISOString();
  const publicRecord: PublicEvidence = {
    version: 1,
    kind: "script-upload",
    filename: p.upload.filename,
    redactedText: p.redactedText,
    addresses: addresses.map((a) => ({ chain: a.chain, address: a.address, assetHint: a.assetHint })),
    urls,
    piiCommitment: sha256Hex(salt + canonicalJson(secrets)),
    createdAt,
  };
  const sealed = sealEvidence(publicRecord, { original: p.original, encoding: p.upload.encoding, pii: secrets }, salt);
  return sealed.evidenceHash;
}

/** Same public record as sealUploadEvidence, hashed in memory only (zero-retention mode: no file, no key). */
export function ephemeralEvidenceHash(p: Prepared, addresses: ExtractedAddress[], urls: string[]): string {
  return sha256Hex(
    canonicalJson({
      version: 1,
      kind: "script-upload",
      filename: p.upload.filename,
      redactedText: p.redactedText,
      addresses: addresses.map((a) => ({ chain: a.chain, address: a.address, assetHint: a.assetHint })),
      urls,
    }),
  );
}

// ───────────────────────── output language (D16: zh first) ─────────────────────────

/** zh material → zh; otherwise the requested UI language; default zh. */
export function resolveOutLang(material: Lang, requested?: Lang): Lang {
  return material === "zh" ? "zh" : (requested ?? "zh");
}

/** ?lang= wins, then Accept-Language (zh unless English is preferred over Chinese), default zh. Mirrors packages/arena i18n. */
export function requestLang(query: URLSearchParams | undefined, acceptLanguage: string | undefined): Lang {
  const q = query?.get("lang");
  if (q === "zh" || q === "en") return q;
  if (!acceptLanguage) return "zh";
  const prefs = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const qv = Number(params.find((x) => x.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { tag: tag ?? "", q: Number.isFinite(qv) ? qv : 0 };
    })
    .sort((a, b) => b.q - a.q);
  for (const pr of prefs) {
    if (pr.tag.startsWith("zh")) return "zh";
    if (pr.tag.startsWith("en")) return "en";
  }
  return "zh";
}

// ───────────────────────── rules engine ─────────────────────────

/** Rules classifier: scammer lines weigh 1, victim lines 0.5 (a victim saying "杀猪盘" is a signal too). */
export function classify(texts: string[], victimTexts: string[] = []): ScriptAnalysis["scamType"] {
  const scores = new Map<ScamType, number>();
  for (const type of SCAM_TYPES) {
    let s = 0;
    for (const [re, w] of TYPE_LEXICON[type]) {
      const hits = texts.filter((t) => re.test(t)).length + 0.5 * victimTexts.filter((t) => re.test(t)).length;
      s += w * Math.min(hits, 3);
    }
    scores.set(type, s);
  }
  // romance + investment talk together is the pig-butchering signature
  const pb = scores.get("pig-butchering")!;
  if (pb > 0) scores.set("pig-butchering", pb + 0.6 * scores.get("investment")!);
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  // strength (saturating) × margin over the runner-up
  const conf = (s: number, next: number) => (s > 0 ? r2((1 - Math.exp(-s / 6)) * (0.4 + (0.6 * (s - next)) / s)) : 0);
  return {
    value: top,
    confidence: conf(topScore, second),
    alternatives: ranked
      .slice(1, 4)
      .filter(([, s]) => s > 0)
      .map(([value, s]) => ({ value, confidence: r2(Math.min(conf(s, 0) * (s / topScore), 0.99)) })),
  };
}

export function segmentStages(lines: Line[], lang: Lang): { stages: ScriptAnalysis["stages"]; lineStage: number[] } {
  let cur = 0;
  const lineStage: number[] = [];
  const lineTags: string[][] = [];
  for (const l of lines) {
    const tags = l.role === "scammer" ? inferTags(l.text) : [];
    lineTags.push(tags);
    for (const t of tags) {
      const st = TAG_STAGE[t];
      if (st !== undefined && st > cur) cur = st;
    }
    if (l.role === "scammer" && tags.includes("urgency") && cur >= 3) cur = 4;
    lineStage.push(cur);
  }
  const stages: ScriptAnalysis["stages"] = [];
  lineStage.forEach((st, i) => {
    const last = stages.at(-1);
    const name = STAGES[st]![lang];
    if (last && last.name === name) {
      last.toLine = i + 1;
      for (const t of lineTags[i]!) if (!last.tactics.includes(t)) last.tactics.push(t);
    } else stages.push({ name, fromLine: i + 1, toLine: i + 1, tactics: [...lineTags[i]!] });
  });
  return { stages, lineStage };
}

export interface RulesOutput {
  analysis: ScriptAnalysis;
  addresses: ExtractedAddress[];
}

let knownFilter: KnownEntityFilter | undefined;
function known(): KnownEntityFilter {
  return (knownFilter ??= new KnownEntityFilter(loadKnownEntities()));
}

export interface RulesOptions {
  /** false = zero-retention: evidence hash is computed in memory, nothing is written (D27) */
  persist?: boolean;
}

export function rulesAnalysis(p: Prepared, engine: AnalysisEngine = "rules", opts: RulesOptions = {}): RulesOutput {
  const lang = p.lang;
  const ui = p.outLang;
  const zh = ui === "zh";
  const scammer = p.lines.map((l, i) => ({ ...l, i })).filter((l) => l.role === "scammer");
  const scammerTexts = scammer.map((l) => l.text);
  const victimTexts = p.lines.filter((l) => l.role === "victim").map((l) => l.text);
  const warnings: string[] = [];

  const scamType = p.script && SCAM_TYPES.includes(p.script.type) ? { value: p.script.type, confidence: 1, alternatives: classify(scammerTexts).alternatives } : classify(scammerTexts, victimTexts);
  const { stages, lineStage } = segmentStages(p.lines, ui);

  // artifacts: addresses + urls from scammer lines (M2 extractor); phones/handles as placeholders
  const addresses: ExtractedAddress[] = [];
  const urls: string[] = [];
  const artifacts: ScriptAnalysis["artifacts"] = [];
  const seen = new Set<string>();
  for (const l of scammer) {
    const ex = extractFromText(l.text);
    for (const a of ex.addresses) {
      const k = `${a.chain}:${a.address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      addresses.push({ ...a, turnIndex: l.i });
      artifacts.push({ kind: "address", chain: a.chain, value: a.address, revealAtStage: lineStage[l.i]! });
    }
    for (const u of ex.urls)
      if (!seen.has(u)) {
        seen.add(u);
        urls.push(u);
        artifacts.push({ kind: "url", value: u, revealAtStage: lineStage[l.i]! });
      }
    for (const m of l.text.matchAll(/\[(PHONE|HANDLE)_\d+\]/g))
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        artifacts.push({ kind: m[1] === "PHONE" ? "phone" : "handle", value: m[0], revealAtStage: lineStage[l.i]! });
      }
  }
  if (p.script) for (const a of p.script.plantedArtifacts) if (!artifacts.some((x) => x.value === a.value)) artifacts.push(a);

  const injections = [...new Set([...scammer.flatMap((l) => detectInjections(l.text)), ...(p.script?.injections ?? [])])];

  const persist = opts.persist !== false;
  const evidenceHash = persist ? sealUploadEvidence(p, addresses, urls) : ephemeralEvidenceHash(p, addresses, urls);
  const alertDrafts: AlertDraft[] = addresses.map((a) => {
    const d: AlertDraft = { chain: a.chain, address: a.address, level: "L1", category: scamType.value, evidenceHash, conversationId: p.id };
    const ent = known().match(a);
    if (ent) d.filteredReason = `known-entity: ${ent.name} (${ent.kind})`;
    return d;
  });

  // draft ScamScriptDef
  const citation = `uploaded by ${p.upload.expertId || "unknown"}, ${p.upload.filename}`;
  const typeLabel = TYPE_LABEL[scamType.value][ui];
  let draft: ScamScriptDef;
  if (p.script) {
    draft = { ...p.script, id: toUploadId(p.script.id, p.id), lang: p.script.lang ?? lang, source: { citation } };
  } else {
    const intro = scammer.find((l) => SELF_INTRO_RE.test(l.text));
    const objections: ScamScriptDef["objections"] = [];
    p.lines.forEach((l, i) => {
      if (l.role !== "victim" || !DOUBT_RE.test(l.text)) return;
      const counters = p.lines.slice(i + 1, i + 4).filter((x) => x.role === "scammer").slice(0, 2).map((x) => x.text);
      if (counters.length) objections.push({ victimSays: l.text, scammerCounters: counters });
    });
    draft = {
      id: toUploadId(`${scamType.value}`, p.id),
      type: scamType.value,
      lang,
      title: zh ? `上传剧本：${typeLabel}（${p.upload.filename}）` : `Uploaded: ${typeLabel} (${p.upload.filename})`,
      persona: intro ? intro.text.slice(0, 200) : zh ? `自称${typeLabel}相关人员的陌生联系人` : `Stranger running a ${typeLabel.toLowerCase()}`,
      hook: (scammer[0]?.text ?? p.lines[0]?.text ?? "").slice(0, 300),
      goal: TYPE_GOAL[scamType.value][ui],
      stages: stages.map((s) => {
        const st = STAGES.find((x) => x[ui] === s.name)!;
        return {
          name: s.name,
          objective: zh ? st.objZh : st.objEn,
          sampleLines: scammer
            .filter((l) => l.i + 1 >= s.fromLine && l.i + 1 <= s.toLine)
            .slice(0, 3)
            .map((l) => l.text.slice(0, 300)),
        };
      }),
      objections: objections.slice(0, 5),
      plantedArtifacts: artifacts,
      injections,
      source: { citation },
    };
  }

  // warnings
  if (!addresses.length) warnings.push(zh ? "缺少收款地址：聊天记录里没有找到链上地址" : "No payment address found in the chat");
  if (scamType.confidence < 0.5) warnings.push(zh ? `类型置信度低（${scamType.confidence}），请人工确认骗局类型` : `Low scam-type confidence (${scamType.confidence}); please confirm the type`);
  if (!p.script && !scammer.length) warnings.push(zh ? "没有识别出骗子一方的发言" : "Could not identify the scammer's messages");
  if (p.notes.includes("no-speakers")) warnings.push(zh ? "没有识别出说话人，整段按骗子话术处理" : "No speakers detected; treating every line as scammer text");
  if (injections.length) warnings.push(zh ? `发现 ${injections.length} 句注入/诱导句，已列入 injections` : `${injections.length} injection line(s) found`);
  const filtered = alertDrafts.filter((d) => d.filteredReason).length;
  if (filtered) warnings.push(zh ? `${filtered} 个地址命中已知机构名单（疑似投毒），不会上链` : `${filtered} address(es) are known entities (possible poisoning); they will not go on chain`);
  const piiCount = p.redactor.findings().length;
  if (piiCount)
    warnings.push(
      persist
        ? zh
          ? `已打码 ${piiCount} 项个人资料；原文已加密保存（evidence ${evidenceHash.slice(0, 12)}…）`
          : `${piiCount} PII item(s) redacted; original encrypted (evidence ${evidenceHash.slice(0, 12)}…)`
        : zh
          ? `已打码 ${piiCount} 项个人资料；零留存模式：原文和结果都没有保存`
          : `${piiCount} PII item(s) redacted; zero-retention mode: nothing was stored`,
    );
  if (!urls.length && !addresses.length) warnings.push(zh ? "没有可上链的情报（地址/网址）" : "No actionable intel (address / URL)");

  const analysis: ScriptAnalysis = {
    id: p.id,
    filename: p.upload.filename,
    format: p.format,
    lang,
    engine,
    redactedText: p.redactedText,
    pii: p.redactor.findings(),
    scamType,
    stages,
    artifacts,
    injections,
    draft,
    alertDrafts,
    warnings,
    at: new Date().toISOString(),
  };
  return { analysis, addresses };
}

export function toUploadId(base: string, analysisId: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "script";
  return `${slug.startsWith("upload-") ? slug : `upload-${slug}`}-${analysisId.slice(-6)}`;
}

// ───────────────────────── uploads: single file or files[] (several screenshots in order) ─────────────────────────

export interface UploadFile {
  filename: string;
  content: string;
  encoding: "utf8" | "base64";
}
/** ScriptUpload + optional files[] (proposed for shared; until then accepted structurally). */
export type ScriptUploadInput = ScriptUpload & { files?: UploadFile[] };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 20;

export function uploadFiles(u: ScriptUploadInput): UploadFile[] {
  if (Array.isArray(u?.files) && u.files.length) {
    if (u.files.length > MAX_FILES) throw new ScriptLabError(`一次最多上传 ${MAX_FILES} 个文件 / at most ${MAX_FILES} files per upload`, 413, "too-many-files");
    for (const f of u.files)
      if (!f || typeof f.filename !== "string" || typeof f.content !== "string" || !["utf8", "base64"].includes(f.encoding))
        throw new ScriptLabError("files[] items must be {filename, content, encoding: utf8|base64}");
    return u.files;
  }
  return [{ filename: u.filename, content: u.content, encoding: u.encoding }];
}

const decodedBytes = (f: UploadFile) => (f.encoding === "base64" ? Math.floor((f.content.replace(/^data:[^,]+,/, "").replace(/=+$/, "").length * 3) / 4) : Buffer.byteLength(f.content));

export function checkSize(upload: ScriptUploadInput): void {
  for (const [i, f] of uploadFiles(upload).entries()) {
    const bytes = decodedBytes(f);
    const isImage = f.encoding === "base64" && /\.(png|jpe?g|webp|gif|heic)$/i.test(f.filename);
    if (isImage || f.encoding === "base64") {
      if (bytes > MAX_IMAGE_BYTES)
        throw new ScriptLabError(
          `第 ${i + 1} 张截图（${f.filename}）有 ${(bytes / 1048576).toFixed(1)}MB，单张不能超过 5MB，请压缩后再传。 / Image ${f.filename} exceeds the 5MB limit.`,
          413,
          "too-large",
        );
    } else if (bytes > MAX_TEXT_BYTES) throw new ScriptLabError(`文件 ${f.filename} 超过 2MB / text file exceeds 2MB`, 413, "too-large");
  }
}

/** One line per message, in the generic "【time】speaker：text" format parseUpload understands. */
export function renderMessages(parsed: ParsedUpload): string {
  return parsed.messages.map((m) => (m.speaker ? `${m.ts ? `【${m.ts}】` : ""}${m.speaker}：${m.text.replace(/\n+/g, " ")}` : m.text)).join("\n");
}

/**
 * Join consecutive transcripts (phone screenshots usually overlap when scrolling):
 * the longest suffix of the previous part that equals a prefix of the next one is dropped
 * (compared without timestamps; a 1-line overlap must be ≥ 8 chars to count).
 */
export function joinTranscripts(parts: string[]): string {
  const key = (l: string) => l.replace(/^\s*[[【][^\]】]*[\]】]\s*/, "").replace(/\s+/g, "");
  const out: string[] = [];
  for (const part of parts) {
    const next = part.split("\n").filter((l) => l.trim());
    let k = Math.min(out.length, next.length);
    for (; k > 0; k--) {
      const a = out.slice(out.length - k).map(key);
      const b = next.slice(0, k).map(key);
      if (a.every((x, i) => x === b[i]) && (k >= 2 || a[0]!.length >= 8)) break;
    }
    out.push(...next.slice(k));
  }
  return out.join("\n");
}

/** Synchronous rules-only analysis (no network, any mode). Images are rejected — use analyzeUpload. */
export function analyze(upload: ScriptUploadInput, opts: { outLang?: Lang } = {}): ScriptAnalysis {
  checkSize(upload);
  const files = uploadFiles(upload);
  const parsedFiles = files.map((f) => parseUpload({ ...upload, ...f }));
  if (parsedFiles.some((p) => p.format === "image")) throw imageOfflineError();
  if (parsedFiles.length === 1) return rulesAnalysis(prepareText(upload, parsedFiles[0]!, undefined, opts.outLang)).analysis;
  const combined = parseUpload({ ...upload, filename: "combined.txt", content: parsedFiles.map(renderMessages).join("\n"), encoding: "utf8" });
  return rulesAnalysis(prepareText({ ...upload, filename: multiName(files) }, combined, JSON.stringify(files), opts.outLang)).analysis;
}

export const multiName = (files: UploadFile[]) => (files.length === 1 ? files[0]!.filename : `${files[0]!.filename} 等 ${files.length} 个文件`);

export function imageOfflineError(reason: "offline" | "no-key" = "offline"): ScriptLabError {
  const why =
    reason === "no-key"
      ? "服务器没有配置 Claude key（ANTHROPIC_API_KEY），无法识别截图。"
      : "当前是离线模式，截图识别需要联网调用 Claude 视觉模型，离线时不支持。";
  return new ScriptLabError(
    `${why}可以改为上传聊天记录导出文件（txt / Telegram JSON / WhatsApp txt），或请管理员以 live 模式启动并配置 ANTHROPIC_API_KEY。 / Screenshot analysis needs live mode and ANTHROPIC_API_KEY (Claude vision); upload a txt/JSON chat export instead.`,
    422,
    "image-offline",
  );
}
