import { createHash } from "node:crypto";
import type { AttestationCheck, AttestationResult, Lang, ScriptAnalysis } from "@baitnet/shared";
import { DEFAULT_NEARAI_MODEL, NEARAI_BASE_URL, allowLiveLLM } from "@baitnet/agent";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { checkSize, prepareText, rulesAnalysis, type Prepared, type ScriptUploadInput, uploadFiles, multiName, renderMessages } from "./analyze.js";
import { ANALYSIS_SYSTEM, extractJson, mergeLlmOutput } from "./llm.js";
import { parseUpload, ScriptLabError } from "./parse.js";

/**
 * D27 — zero-retention ("零留存") analysis for the 03 Privacy track.
 *
 * Everything happens in memory and is returned to the browser only:
 *   - no data/evidence file (the evidence hash is computed, not sealed; no key file is created)
 *   - no sqlite access at all (not even reads)
 *   - nothing about the content in logs (the route logs only "一次零留存分析，耗时 X ms")
 * The model call goes ONLY to NEAR AI Cloud (TEE-hosted model, OpenAI-compatible API). There is
 * never a fallback to Claude, which does not run in a TEE. Each call gets a fresh nonce and its
 * own attestation report (verified with the M10 logic) and, when available, a response signature
 * bound to this call's chat id. See docs/dev/zero-retention.md.
 */

/** Local extension of ScriptAnalysis (proposed for packages/shared). */
export type EphemeralAnalysis = ScriptAnalysis & { ephemeral: true; attestation: AttestationResult };

/** Structural view of apps/server/src/attestation.ts (M10); B1 passes that module as ctx.attestation. */
export interface M10Verifier {
  newNonce(): string;
  fetchReport(model: string, nonce: string, f?: typeof fetch): Promise<unknown>;
  verifyReport(
    report: any,
    nonce: string,
    model: string,
    opts?: { online?: boolean; recordedExternal?: any; fetchImpl?: typeof fetch },
  ): Promise<{ checks: AttestationCheck[]; signingAddress?: string }>;
  loadRecorded(): { recorded: { at: string; model: string; nonce: string }; report: unknown } | null;
}

export interface EphemeralOptions {
  env?: NodeJS.ProcessEnv;
  m10?: M10Verifier;
  fetchImpl?: typeof fetch;
  outLang?: Lang;
}

// ───────────────────────── model selection ─────────────────────────

interface ModelInfo {
  id: string;
  [k: string]: unknown;
}

/** TEE-hosted? NEAR AI Cloud marks private models in their metadata; we accept any explicit TEE/attestation flag. */
export function isTeeModel(m: ModelInfo): boolean {
  if (m.tee === true || m.attestation === true || m.confidential === true || m.private === true) return true;
  const meta = JSON.stringify({ metadata: m.metadata, features: m.features, tags: m.tags, hosting: m.hosting, verifiable: m.verifiable }).toLowerCase();
  return /\b(tee|tdx|confidential|attest(ed|ation)?|verifiable)\b|"verifiable":true/.test(meta);
}

/** Preferred (NEARAI_MODEL) if it is TEE-hosted, else the first TEE-hosted model; undefined if none is marked. */
export function pickTeeModel(models: ModelInfo[], preferred?: string): string | undefined {
  const tee = models.filter(isTeeModel);
  return tee.find((m) => m.id === preferred)?.id ?? tee[0]?.id;
}

// ───────────────────────── response signature (ECDSA, Ethereum personal_sign) ─────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function personalSignHash(text: string): Uint8Array {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  return keccak_256(new Uint8Array([...prefix, ...msg]));
}

/** 0x r‖s‖v (v = 27/28 or 0/1) → checksum-free lowercase 0x address, or undefined if malformed. */
export function recoverSigner(text: string, signatureHex: string): string | undefined {
  try {
    const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    if (sig.length !== 65) return undefined;
    const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
    const recovered = new Uint8Array([v, ...sig.subarray(0, 64)]); // noble "recovered" layout: [rec, r, s]
    const pub = secp256k1.recoverPublicKey(recovered, personalSignHash(text), { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    return "0x" + Buffer.from(keccak_256(uncompressed.subarray(1)).subarray(12)).toString("hex");
  } catch {
    return undefined;
  }
}

export interface ResponseSignature {
  text: string; // "<sha256(request body)>:<sha256(response body)>"
  signature: string;
  signing_address: string;
  signing_algo?: string;
}

/** Checks binding this exact request/response (chat id) to a key, and that key to the attested model key. */
export function verifyResponseSignature(
  sig: ResponseSignature,
  call: { chatId: string; requestBody: string; responseBody: string },
  attestedAddress?: string,
): AttestationCheck[] {
  const checks: AttestationCheck[] = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name: `response signature: ${name}`, pass, detail });
  const [reqHash, respHash] = String(sig.text ?? "").split(":");
  push("request hash matches this call", reqHash === sha256(call.requestBody), `signed ${reqHash?.slice(0, 12)}… vs sha256(our request) ${sha256(call.requestBody).slice(0, 12)}…`);
  push(`response hash matches chat ${call.chatId}`, respHash === sha256(call.responseBody), `signed ${respHash?.slice(0, 12)}… vs sha256(response body) ${sha256(call.responseBody).slice(0, 12)}…`);
  const signer = recoverSigner(sig.text, sig.signature);
  push("ECDSA recovers signing_address", !!signer && signer === sig.signing_address?.toLowerCase(), `recovered ${signer ?? "(invalid signature)"} vs ${sig.signing_address}`);
  push(
    "signer is the attested model key",
    !!attestedAddress && sig.signing_address?.toLowerCase() === attestedAddress.toLowerCase(),
    `signing_address ${sig.signing_address} vs attested ${attestedAddress ?? "(no attestation)"}`,
  );
  return checks;
}

// ───────────────────────── NEAR AI Cloud calls ─────────────────────────

function base(env: NodeJS.ProcessEnv) {
  return env.NEARAI_BASE_URL ?? NEARAI_BASE_URL;
}

async function listModels(env: NodeJS.ProcessEnv, f: typeof fetch): Promise<ModelInfo[]> {
  const res = await f(`${base(env)}/models`, { headers: { authorization: `Bearer ${env.NEARAI_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`models HTTP ${res.status}`);
  const j = (await res.json()) as { data?: ModelInfo[] } | ModelInfo[];
  return Array.isArray(j) ? j : (j.data ?? []);
}

async function teeChat(env: NodeJS.ProcessEnv, f: typeof fetch, model: string, p: Prepared) {
  const numbered = p.redactedText
    .split("\n")
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");
  const requestBody = JSON.stringify({
    model,
    max_tokens: 3000,
    temperature: 0.2,
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM },
      { role: "user", content: `OUTPUT LANGUAGE: ${p.outLang === "zh" ? "Chinese (简体中文)" : "English"}\n\n${numbered.slice(0, 60_000)}` },
    ],
  });
  const res = await f(`${base(env)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.NEARAI_API_KEY}` },
    body: requestBody,
    signal: AbortSignal.timeout(90_000),
  });
  const responseBody = await res.text();
  if (!res.ok) throw new Error(`NEAR AI chat HTTP ${res.status}`); // never echo the body: it may contain content
  const j = JSON.parse(responseBody) as { id?: string; choices?: { message?: { content?: string } }[] };
  return { chatId: j.id ?? "", content: j.choices?.[0]?.message?.content ?? "", requestBody, responseBody };
}

async function fetchSignature(env: NodeJS.ProcessEnv, f: typeof fetch, chatId: string, model: string): Promise<ResponseSignature> {
  const url = new URL(`${base(env)}/signature/${encodeURIComponent(chatId)}`);
  url.searchParams.set("model", model);
  url.searchParams.set("signing_algo", "ecdsa");
  const res = await f(url, { headers: { authorization: `Bearer ${env.NEARAI_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`signature HTTP ${res.status}`);
  return (await res.json()) as ResponseSignature;
}

async function recordedAttestation(m10: M10Verifier | undefined): Promise<AttestationResult> {
  const at = new Date().toISOString();
  const rec = m10?.loadRecorded();
  if (!m10 || !rec)
    return { model: "", nonce: "", checks: [{ name: "attestation available", pass: false, detail: m10 ? "no recorded sample" : "M10 verifier not wired (ctx.attestation)" }], verified: false, recorded: true, at };
  const { checks, signingAddress } = await m10.verifyReport(rec.report, rec.recorded.nonce, rec.recorded.model, { online: false, recordedExternal: rec.recorded });
  return { model: rec.recorded.model, nonce: rec.recorded.nonce, signingAddress, checks, verified: checks.every((c) => c.pass), recorded: true, at: rec.recorded.at };
}

const RECORDED_WARNING: Record<Lang, string> = {
  zh: "未连接 NEAR AI Cloud，展示的是录制样例：attestation 为录制样例；本次分析由本地规则引擎在内存中完成，没有调用任何外部模型（不会改用 Claude，因为 Claude 不在 TEE 里运行）",
  en: "Not connected to NEAR AI Cloud — showing a recorded sample: the attestation is a recording; this analysis ran in memory with the local rules engine and no external model (no fallback to Claude, which does not run in a TEE)",
};

/**
 * Zero-retention analysis. Pure function of the upload + network calls to NEAR AI Cloud (and the
 * public attestation verifiers used by M10). Writes nothing, logs nothing.
 */
export async function analyzeEphemeral(upload: ScriptUploadInput, opts: EphemeralOptions = {}): Promise<EphemeralAnalysis> {
  const env = opts.env ?? process.env;
  const f = opts.fetchImpl ?? fetch;
  checkSize(upload);
  const files = uploadFiles(upload);
  const parsedFiles = files.map((x) => parseUpload({ ...upload, ...x }));
  if (parsedFiles.some((x) => x.format === "image"))
    throw new ScriptLabError(
      "零留存模式暂不支持截图：截图识别要用 Claude，而 Claude 不在 TEE 里运行。请关闭零留存开关后再传截图，或上传文字聊天记录。 / Zero-retention mode does not accept screenshots (vision runs on Claude, outside a TEE).",
      422,
      "ephemeral-image",
    );
  const parsed =
    parsedFiles.length === 1 ? parsedFiles[0]! : parseUpload({ ...upload, filename: "combined.txt", content: parsedFiles.map(renderMessages).join("\n"), encoding: "utf8" });
  // original content is never kept: no originalOverride, nothing sealed
  const p = prepareText({ ...upload, filename: multiName(files) }, parsed, "", opts.outLang);
  const zh = p.outLang === "zh";
  const { analysis: base0 } = rulesAnalysis(p, "rules", { persist: false });
  const warnings = [...base0.warnings];

  const live = allowLiveLLM(env) && !!env.NEARAI_API_KEY;
  if (!live) {
    const attestation = await recordedAttestation(opts.m10);
    return { ...base0, warnings: [RECORDED_WARNING[p.outLang], ...warnings], ephemeral: true, attestation };
  }

  // 1. TEE model from the models endpoint
  let model = env.NEARAI_MODEL ?? DEFAULT_NEARAI_MODEL;
  try {
    const picked = pickTeeModel(await listModels(env, f), env.NEARAI_MODEL);
    if (picked) model = picked;
    else warnings.push(zh ? `models 端点没有标明 TEE 模型，使用 ${model}，以 attestation 校验结果为准` : `No model is marked TEE in /models; using ${model} — rely on the attestation result`);
  } catch (e) {
    warnings.push(zh ? `读取 models 端点失败（${(e as Error).message}），使用 ${model}` : `Could not read /models (${(e as Error).message}); using ${model}`);
  }

  // 2. attestation for this call (fresh nonce) in parallel with the chat
  const m10 = opts.m10;
  const nonce = m10?.newNonce() ?? "";
  const attestP: Promise<AttestationResult> = (async () => {
    if (!m10) return { model, nonce, checks: [{ name: "attestation available", pass: false, detail: "M10 verifier not wired (ctx.attestation)" }], verified: false, recorded: false, at: new Date().toISOString() };
    const report = await m10.fetchReport(model, nonce, f);
    const { checks, signingAddress } = await m10.verifyReport(report, nonce, model, { online: true, fetchImpl: f });
    return { model, nonce, signingAddress, checks, verified: checks.every((c) => c.pass), recorded: false, at: new Date().toISOString() };
  })();

  let analysis: ScriptAnalysis = base0;
  let call: Awaited<ReturnType<typeof teeChat>> | undefined;
  try {
    call = await teeChat(env, f, model, p);
    try {
      analysis = mergeLlmOutput(base0, extractJson(call.content), "nearai", p.lines.length);
    } catch (e) {
      warnings.push(zh ? `TEE 模型输出无效，已退回本地规则引擎：${(e as Error).message.slice(0, 80)}` : `TEE model output invalid, fell back to rules: ${(e as Error).message.slice(0, 80)}`);
    }
  } catch (e) {
    warnings.push(zh ? `NEAR AI Cloud 调用失败（${(e as Error).message}），本次结果来自本地规则引擎（仍然零留存）` : `NEAR AI Cloud call failed (${(e as Error).message}); result from the local rules engine (still zero-retention)`);
  }

  let attestation: AttestationResult;
  try {
    attestation = await attestP;
  } catch (e) {
    attestation = await recordedAttestation(m10);
    warnings.push(zh ? `attestation 拉取失败（${(e as Error).message}），展示的是录制样例` : `Attestation fetch failed (${(e as Error).message}); showing the recorded sample`);
  }

  // 3. response signature bound to this chat id
  if (call?.chatId) {
    try {
      const sig = await fetchSignature(env, f, call.chatId, model);
      const sigChecks = verifyResponseSignature(sig, call, attestation.recorded ? undefined : attestation.signingAddress);
      attestation = { ...attestation, checks: [...attestation.checks, ...sigChecks], verified: attestation.verified && sigChecks.every((c) => c.pass) };
    } catch (e) {
      attestation = { ...attestation, checks: [...attestation.checks, { name: "response signature: available", pass: false, detail: (e as Error).message }], verified: false };
    }
  }
  if (!attestation.verified) warnings.push(zh ? "attestation 有未通过的检查项，请查看 Verified 面板" : "Some attestation checks failed; see the Verified panel");
  return { ...analysis, warnings: [...warnings, ...analysis.warnings.filter((w) => !warnings.includes(w))], ephemeral: true, attestation };
}
