import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, decrypt, openEvidence, sealConversationEvidence, sha256Hex, loadEvidenceKey } from "../src/extract/evidence.js";
import { extractFromConversation } from "../src/extract/extract.js";
import { ReplayProvider } from "../src/llm/provider.js";

const conv = new ReplayProvider().fixture("investment");

describe("evidence", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }], e: "中" })).toBe('{"a":[{"d":2}],"b":1,"e":"中"}');
  });
  it("hash = sha256(utf8(plaintext)); PII only inside the AES-GCM blob", () => {
    const ex = extractFromConversation(conv);
    const s = sealConversationEvidence(conv, ex);
    expect(s.evidenceHash).toBe(sha256Hex(Buffer.from(s.plaintext, "utf8")));
    expect(s.plaintext).not.toContain("7700 900461");
    expect(s.plaintext).not.toContain("GoldBridge_Amy");
    const file = readFileSync(s.file, "utf8");
    expect(file).not.toContain("goldbridge"); // encrypted at rest
    const opened = openEvidence(s.evidenceHash)!;
    expect(opened.hashMatches).toBe(true);
    expect(opened.plaintext).toBe(s.plaintext);
    expect((opened.secret as any).phones).toEqual(["+44 7700 900461"]);
  });
  it("tampered ciphertext fails authentication", () => {
    const s = sealConversationEvidence(conv, extractFromConversation(conv));
    const blob = JSON.parse(readFileSync(s.file, "utf8"));
    const ct = Buffer.from(blob.ciphertext, "base64");
    ct[0] ^= 1;
    expect(() => decrypt({ ...blob, ciphertext: ct.toString("base64") }, loadEvidenceKey())).toThrow();
  });
  it("uses BAITNET_EVIDENCE_KEY when set", () => {
    process.env.BAITNET_EVIDENCE_KEY = "11".repeat(32);
    expect(loadEvidenceKey().toString("hex")).toBe("11".repeat(32));
    process.env.BAITNET_EVIDENCE_KEY = "short";
    expect(() => loadEvidenceKey()).toThrow();
    delete process.env.BAITNET_EVIDENCE_KEY;
  });
});
