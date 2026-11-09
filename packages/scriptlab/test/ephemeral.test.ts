import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScamScriptDef } from "@baitnet/shared";
import { dataDir, fixturePath } from "@baitnet/agent";
import { createMiniRouter, openTrainingDb, type MiniRouter, type TrainingDb } from "@baitnet/training";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
// the real M10 verifier (B1 passes this module as ctx.attestation)
import * as m10 from "../../../apps/server/src/attestation.js";
import { analyzeEphemeral, getAnalysis, isTeeModel, pickTeeModel, personalSignHash, recoverSigner, registerScriptLabRoutes, verifyResponseSignature, type EphemeralAnalysis } from "../src/index.js";

const ZH = readFileSync(fixturePath("training", "samples", "zh-pig-butchering.txt"), "utf8");
const EN = readFileSync(fixturePath("training", "samples", "en-telegram-export.json"), "utf8");
const KEYS = ["BAITNET_MODE", "NEARAI_API_KEY", "ANTHROPIC_API_KEY", "BAITNET_LLM", "NEARAI_MODEL", "BAITNET_LIVE_ATTESTATION"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

// ───────────── helpers: data-dir snapshot, sqlite spy, leak check ─────────────

function snapshot(dir = dataDir()): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.set(p, `${st.size}:${st.mtimeMs}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return out;
}

function spySqlite() {
  const sql: string[] = [];
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, s: string) {
    sql.push(s);
    throw new Error("sqlite used during zero-retention analysis");
  } as never);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (s: string) {
    sql.push(s);
    throw new Error("sqlite used during zero-retention analysis");
  } as never);
  return sql;
}

/** Every 4-char window of the sample's message texts (whitespace-free). */
function fragments(sample: string): string[] {
  const text = sample.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 4 <= text.length; i++) out.add(text.slice(i, i + 4));
  return [...out];
}

function setup(): { router: MiniRouter; logs: string[]; db: TrainingDb } {
  const db = openTrainingDb(join(dataDir(), "training.sqlite")); // opened before the snapshot, like the server does at start-up
  const router = createMiniRouter();
  const logs: string[] = [];
  registerScriptLabRoutes(router, { log: (l) => logs.push(l), dataPath: (...p) => join(dataDir(), ...p), db, attestation: m10 });
  return { router, logs, db };
}

// ───────────── fake NEAR AI Cloud (live mode) ─────────────

const sk = secp256k1.utils.randomSecretKey();
const addrOf = (secret: Uint8Array) => "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12)).toString("hex");
const signerAddress = addrOf(sk);
function ethSign(text: string, secret = sk): string {
  const sig = secp256k1.sign(personalSignHash(text), secret, { prehash: false, format: "recovered" });
  return "0x" + Buffer.from([...sig.subarray(1), sig[0]! + 27]).toString("hex");
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TEE_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

function fakeCloud(opts: { tamperResponseHash?: boolean } = {}) {
  const rec = JSON.parse(readFileSync(fixturePath("attestation", "sample-report.json"), "utf8"));
  rec.report.model_attestations[0].signing_address = signerAddress;
  const seen: { url: string; nonce?: string; body?: string }[] = [];
  let chat: { req: string; resp: string } | undefined;
  const fn = vi.fn(async (input: string | URL, init?: { body?: string }) => {
    const url = String(input);
    seen.push({ url, nonce: new URL(url).searchParams.get("nonce") ?? undefined, body: init?.body });
    if (url.includes("anthropic.com")) throw new Error("Claude must never be used in zero-retention mode");
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "plain-model" }, { id: TEE_MODEL, metadata: { tee: true } }] });
    if (url.includes("/attestation/report")) return Response.json(rec.report);
    if (url.includes("phala.network")) return Response.json({ quote: { verified: true } });
    if (url.includes("nvidia.com")) return Response.json([["JWT", `x.${Buffer.from(JSON.stringify({ "x-nvidia-overall-att-result": true })).toString("base64url")}.y`], {}]);
    if (url.endsWith("/chat/completions")) {
      const content = JSON.stringify({
        scamType: { value: "pig-butchering", confidence: 0.93, alternatives: [] },
        stages: [{ name: "接近", fromLine: 1, toLine: 2, tactics: ["rapport"] }],
        injections: [],
        draft: { title: "TEE 分析：杀猪盘", persona: "自称做金融的网友", hook: "加错微信", goal: "引导充值", stages: [{ name: "接近", objective: "建立信任", sampleLines: ["加错微信了"] }], objections: [] },
      });
      const resp = JSON.stringify({ id: "chatcmpl-zr-1", choices: [{ message: { role: "assistant", content } }] });
      chat = { req: init!.body!, resp };
      return new Response(resp, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/signature/chatcmpl-zr-1")) {
      const text = `${sha(chat!.req)}:${opts.tamperResponseHash ? sha("other") : sha(chat!.resp)}`;
      return Response.json({ text, signature: ethSign(text), signing_address: signerAddress, signing_algo: "ecdsa" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fn, seen };
}

// ───────────── tests ─────────────

describe("zero-retention: model pick + response signature", () => {
  it("picks the TEE-hosted model from /models", () => {
    expect(isTeeModel({ id: "a", metadata: { tee: true } })).toBe(true);
    expect(isTeeModel({ id: "b" })).toBe(false);
    expect(pickTeeModel([{ id: "b" }, { id: "a", metadata: { tee: true } }], "b")).toBe("a");
    expect(pickTeeModel([{ id: "a", tee: true }, { id: "c", tee: true }], "c")).toBe("c");
    expect(pickTeeModel([{ id: "b" }])).toBeUndefined();
  });
  it("ECDSA personal_sign recovery + binding to request/response/attested key", () => {
    const text = `${sha("req")}:${sha("resp")}`;
    const sig = ethSign(text);
    expect(recoverSigner(text, sig)).toBe(signerAddress);
    const ok = verifyResponseSignature({ text, signature: sig, signing_address: signerAddress }, { chatId: "c1", requestBody: "req", responseBody: "resp" }, signerAddress);
    expect(ok.every((c) => c.pass)).toBe(true);
    const bad = verifyResponseSignature({ text, signature: sig, signing_address: signerAddress }, { chatId: "c1", requestBody: "req", responseBody: "tampered" }, "0x0000000000000000000000000000000000000001");
    expect(bad.filter((c) => !c.pass).map((c) => c.name)).toEqual(["response signature: response hash matches chat c1", "response signature: signer is the attested model key"]);
    expect(recoverSigner(text, ethSign(text, secp256k1.utils.randomSecretKey()))).not.toBe(signerAddress);
  });
});

describe("zero-retention: offline / no NEARAI key → recorded sample, never Claude", () => {
  for (const [label, env] of [
    ["offline mode", { BAITNET_MODE: "offline", NEARAI_API_KEY: "nk", ANTHROPIC_API_KEY: "ak" }],
    ["live without NEARAI key (Claude key present)", { BAITNET_MODE: "live", ANTHROPIC_API_KEY: "ak" }],
  ] as const)
    it(label, async () => {
      delete process.env.NEARAI_API_KEY;
      Object.assign(process.env, env);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const a = await analyzeEphemeral({ filename: "zh.txt", content: ZH, encoding: "utf8", expertId: "e" }, { m10 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(a.ephemeral).toBe(true);
      expect(a.engine).toBe("rules");
      expect(a.attestation.recorded).toBe(true);
      expect(a.attestation.checks.length).toBeGreaterThan(3);
      expect(a.warnings[0]).toMatch(/^未连接 NEAR AI Cloud，展示的是录制样例/);
      expect(a.scamType.value).toBe("pig-butchering");
      expect(a.redactedText).not.toContain("王小明");
    });
});

describe("zero-retention leaves no data behind (route, offline + live)", () => {
  beforeAll(() => {
    // make sure the data dir has some state the analysis could touch
    openTrainingDb(join(dataDir(), "training.sqlite")).close();
  });

  for (const mode of ["offline", "live"] as const)
    for (const [name, sample, filename] of [
      ["zh txt", ZH, "zh.txt"],
      ["en telegram", EN, "en.json"],
    ] as const)
      it(`${mode} · ${name}: no file added/changed, no sqlite call, log has no content`, async () => {
        const { router, logs } = setup();
        if (mode === "live") {
          Object.assign(process.env, { BAITNET_MODE: "live", NEARAI_API_KEY: "nk", ANTHROPIC_API_KEY: "ak" });
          vi.stubGlobal("fetch", fakeCloud().fn);
        } else {
          Object.assign(process.env, { BAITNET_MODE: "offline", NEARAI_API_KEY: "nk" });
          vi.stubGlobal("fetch", vi.fn());
        }
        const consoleLines: string[] = [];
        for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(" ")));
        logs.length = 0; // drop the "routes mounted" line from registration
        const before = snapshot();
        const sql = spySqlite();
        const r = await router.dispatch("POST", "/scripts/analyze-ephemeral", { filename, content: sample, encoding: "utf8" });
        vi.mocked(DatabaseSync.prototype.prepare).mockRestore();
        vi.mocked(DatabaseSync.prototype.exec).mockRestore();
        expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
        expect(sql).toEqual([]);
        expect(snapshot()).toEqual(before);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(/^\[scriptlab\] 一次零留存分析，耗时 \d+ ms$/);
        const allLogs = [...logs, ...consoleLines].join("\n").replace(/\s+/g, "");
        const leaked = fragments(sample).filter((f) => allLogs.includes(f));
        expect(leaked).toEqual([]);
        const a = r.body as EphemeralAnalysis;
        expect(a.ephemeral).toBe(true);
        expect(getAnalysis(a.id)).toBeUndefined(); // not in script_analyses
      });

  it("live: TEE model from /models, fresh nonce, response signature bound to the chat id", async () => {
    const { router } = setup();
    Object.assign(process.env, { BAITNET_MODE: "live", NEARAI_API_KEY: "nk" });
    const cloud = fakeCloud();
    vi.stubGlobal("fetch", cloud.fn);
    const a = (await router.dispatch("POST", "/scripts/analyze-ephemeral", { filename: "zh.txt", content: ZH, encoding: "utf8" })).body as EphemeralAnalysis;
    expect(a.engine).toBe("nearai");
    expect(a.draft.title).toBe("TEE 分析：杀猪盘");
    expect(cloud.seen.some((s) => s.url.includes("anthropic"))).toBe(false);
    const chatReq = JSON.parse(cloud.seen.find((s) => s.url.endsWith("/chat/completions"))!.body!);
    expect(chatReq.model).toBe(TEE_MODEL);
    expect(JSON.stringify(chatReq)).not.toContain("王小明"); // only the redacted transcript leaves the server
    const att = cloud.seen.find((s) => s.url.includes("/attestation/report"))!;
    expect(att.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(att.nonce).toBe(a.attestation.nonce);
    expect(a.attestation.recorded).toBe(false);
    expect(a.attestation.model).toBe(TEE_MODEL);
    const sigChecks = a.attestation.checks.filter((c) => c.name.startsWith("response signature"));
    expect(sigChecks).toHaveLength(4);
    expect(sigChecks.every((c) => c.pass)).toBe(true);
    expect(sigChecks.some((c) => c.name.includes("chatcmpl-zr-1"))).toBe(true);
    // the recorded quote binds the recording's nonce, not ours → honestly not verified
    expect(a.attestation.checks.find((c) => c.name === "model: report_data binds signing_address + nonce")!.pass).toBe(false);
    expect(a.attestation.verified).toBe(false);
  });

  it("live: a response hash that does not match this call fails the signature check", async () => {
    Object.assign(process.env, { BAITNET_MODE: "live", NEARAI_API_KEY: "nk" });
    vi.stubGlobal("fetch", fakeCloud({ tamperResponseHash: true }).fn);
    const a = await analyzeEphemeral({ filename: "zh.txt", content: ZH, encoding: "utf8", expertId: "e" }, { m10 });
    expect(a.attestation.checks.find((c) => c.name.startsWith("response signature: response hash"))!.pass).toBe(false);
    expect(a.attestation.verified).toBe(false);
  });

  it("screenshots are refused in zero-retention mode (vision would need Claude)", async () => {
    Object.assign(process.env, { BAITNET_MODE: "live", NEARAI_API_KEY: "nk", ANTHROPIC_API_KEY: "ak" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64");
    await expect(analyzeEphemeral({ filename: "s.png", content: png, encoding: "base64", expertId: "e" }, { m10 })).rejects.toMatchObject({ status: 422, code: "ephemeral-image" });
  });

  it("save after user confirmation: only then is anything written", async () => {
    const { router, db } = setup();
    process.env.BAITNET_MODE = "offline";
    vi.stubGlobal("fetch", vi.fn());
    const a = (await router.dispatch("POST", "/scripts/analyze-ephemeral", { filename: "zh.txt", content: ZH, encoding: "utf8" })).body as EphemeralAnalysis;
    expect(getAnalysis(a.id, db)).toBeUndefined();
    // plain save without the analysis → 404 (nothing was stored)
    expect((await router.dispatch("POST", `/scripts/analyses/${a.id}/save`, { draft: a.draft })).status).toBe(404);
    const tampered = { ...a, redactedText: a.redactedText + "\n骗子：我叫王小明，电话 13812345678" };
    const r = await router.dispatch("POST", `/scripts/analyses/${a.id}/save`, { draft: a.draft, analysis: tampered });
    expect(r.status).toBe(200);
    expect((r.body as ScamScriptDef).id).toBe(a.draft.id);
    const stored = getAnalysis(a.id, db)!;
    expect(stored.redactedText).not.toMatch(/王小明|13812345678/);
    expect("attestation" in stored).toBe(false);
    expect("ephemeral" in stored).toBe(false);
    expect(existsSync(join(dataDir(), "evidence", `${stored.alertDrafts[0]!.evidenceHash}.json`))).toBe(true);
  });
});
