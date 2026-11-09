import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation } from "@baitnet/shared";
import { dataPath } from "../paths.js";
import { redactConversation, type Extraction } from "./extract.js";

/**
 * Evidence model
 * --------------
 * public record  = { conversation (PII-redacted), extracted addresses + URLs, piiCommitment }
 * evidenceHash   = sha256(canonical JSON of the public record)   ← the only thing on chain
 * encrypted blob = AES-256-GCM({ public record, pii: { phones, telegrams, fullConversation }, salt })
 *
 * Phones / Telegram handles live ONLY inside the encrypted blob: they are not on
 * chain, not hashed on chain on their own (the commitment is salted), and not in
 * any plaintext log. The dashboard can recompute evidenceHash from the public
 * record without ever seeing PII.
 *
 * Privacy (M10): when the bait conversation ran through NEAR AI Cloud, the
 * server keeps only this encrypted evidence and the redacted copy — never a
 * plaintext transcript log.
 */

export interface PublicEvidence {
  version: 1;
  kind: "bait-conversation" | "trace" | "script-upload";
  conversation?: Conversation;
  /** script-upload only: original filename and the PII-redacted text */
  filename?: string;
  redactedText?: string;
  addresses: { chain: string; address: string; assetHint?: string; turnIndex?: number }[];
  urls: string[];
  /** sha256(salt || canonical(pii)) — proves PII existed without revealing it */
  piiCommitment: string;
  extra?: Record<string, unknown>;
  createdAt: string;
}

export interface SealedEvidence {
  evidenceHash: string;
  file: string;
  publicRecord: PublicEvidence;
  /** exact string that was hashed */
  plaintext: string;
}

/** Deterministic JSON (sorted keys) so the hash is reproducible anywhere. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function evidenceDir() {
  return process.env.BAITNET_EVIDENCE_DIR ?? dataPath("evidence");
}

/** 32-byte key from BAITNET_EVIDENCE_KEY (hex or base64); otherwise a generated local key file (0600). */
export function loadEvidenceKey(): Buffer {
  const env = process.env.BAITNET_EVIDENCE_KEY;
  if (env) {
    const k = /^[0-9a-fA-F]{64}$/.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("BAITNET_EVIDENCE_KEY must be 32 bytes (64 hex chars or base64)");
    return k;
  }
  const dir = evidenceDir();
  const keyFile = join(dir, ".key");
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
  mkdirSync(dir, { recursive: true });
  const k = randomBytes(32);
  writeFileSync(keyFile, k.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* best effort */
  }
  return k;
}

export function encrypt(plain: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { alg: "AES-256-GCM", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ct.toString("base64") };
}

export function decrypt(blob: { iv: string; tag: string; ciphertext: string }, key: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(blob.ciphertext, "base64")), d.final()]);
}

export function buildPublicEvidence(conv: Conversation, ex: Extraction, salt: string, createdAt: string): PublicEvidence {
  const pii = { phones: ex.phones, telegrams: ex.telegrams };
  return {
    version: 1,
    kind: "bait-conversation",
    conversation: redactConversation(conv),
    addresses: ex.addresses.map((a) => ({ chain: a.chain, address: a.address, assetHint: a.assetHint, turnIndex: a.turnIndex })),
    urls: ex.urls,
    piiCommitment: sha256Hex(salt + canonicalJson(pii)),
    createdAt,
  };
}

/** Encrypt and store; returns the hash that goes on chain. */
export function sealEvidence(publicRecord: PublicEvidence, secret: Record<string, unknown>, salt: string, key = loadEvidenceKey()): SealedEvidence {
  const plaintext = canonicalJson(publicRecord);
  const evidenceHash = sha256Hex(plaintext);
  const blob = encrypt(Buffer.from(JSON.stringify({ publicRecord, secret, salt })), key);
  const dir = evidenceDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${evidenceHash}.json`);
  writeFileSync(file, JSON.stringify({ evidenceHash, ...blob }, null, 2));
  return { evidenceHash, file, publicRecord, plaintext };
}

export function sealConversationEvidence(conv: Conversation, ex: Extraction, key?: Buffer): SealedEvidence {
  const salt = randomBytes(16).toString("hex");
  // createdAt from the conversation keeps replay output stable
  const createdAt = conv.turns.at(-1)?.ts ?? new Date().toISOString();
  const pub = buildPublicEvidence(conv, ex, salt, createdAt);
  return sealEvidence(pub, { phones: ex.phones, telegrams: ex.telegrams, fullConversation: conv }, salt, key);
}

/** Load + decrypt an evidence file by hash. Returns the public record and verification. */
export function openEvidence(evidenceHash: string, key = loadEvidenceKey()) {
  const file = join(evidenceDir(), `${evidenceHash.toLowerCase()}.json`);
  if (!existsSync(file)) return null;
  const blob = JSON.parse(readFileSync(file, "utf8"));
  const inner = JSON.parse(decrypt(blob, key).toString("utf8")) as { publicRecord: PublicEvidence; secret: Record<string, unknown>; salt: string };
  const plaintext = canonicalJson(inner.publicRecord);
  return { ...inner, plaintext, hashMatches: sha256Hex(plaintext) === evidenceHash.toLowerCase() };
}
