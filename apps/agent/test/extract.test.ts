import { describe, expect, it } from "vitest";
import { detectChain, extractFromConversation, extractFromText, redactText } from "../src/extract/extract.js";
import { ReplayProvider } from "../src/llm/provider.js";

describe("address extraction", () => {
  it("finds all four address formats", () => {
    const r = extractFromText(
      "send to goldbridge-desk.near or 0x220954f527d61a281b50846419d12a1154c7da46, TRC20: TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB, btc bc1q6dscnz3avmlmnj27ykfpl4wdf3dh2wmrjmz26h or legacy 1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    );
    expect(r.addresses.map((a) => `${a.chain}:${a.address}`)).toEqual([
      "evm:0x220954f527d61a281b50846419d12a1154c7da46",
      "tron:TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB",
      "btc:bc1q6dscnz3avmlmnj27ykfpl4wdf3dh2wmrjmz26h",
      "btc:1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
      "near:goldbridge-desk.near",
    ]);
    expect(r.addresses.find((a) => a.chain === "tron")!.assetHint).toBe("USDT-TRC20");
  });
  it("does not mistake URL hosts or emails for NEAR accounts", () => {
    const r = extractFromText("see https://app.near.org/x and https://wallet.near/abc, mail ops@shop.near.example, real: alice.testnet. ok");
    expect(r.addresses.map((a) => a.address)).toEqual(["alice.testnet"]);
    expect(r.urls).toEqual(["https://app.near.org/x", "https://wallet.near/abc"]);
  });
  it("extracts phones and telegram handles as PII and redacts them", () => {
    const t = "Telegram @GoldBridge_Amy or WhatsApp +44 7700 900461, HK +852 5123 4567";
    const r = extractFromText(t);
    expect(r.phones).toEqual(["+44 7700 900461", "+852 5123 4567"]);
    expect(r.telegrams).toEqual(["@GoldBridge_Amy"]);
    expect(redactText(t)).not.toMatch(/7700|GoldBridge_Amy|5123/);
  });
  it("detectChain classifies bare addresses", () => {
    expect(detectChain("0x7d72774a3c9680e6d2921350f889b48ba2f3b24d")).toBe("evm");
    expect(detectChain("TWBUfSVjgRGQSENodtV6N1yattFFEHG31X")).toBe("tron");
    expect(detectChain("bc1qz8w4hm6vq3c0d7e2kxt5ya9jn4r6sp2fug8lc7")).toBe("btc");
    expect(detectChain("victim-wallet-88.near")).toBe("near");
    expect(detectChain("not an address")).toBeUndefined();
  });
  it("every replay fixture yields ≥1 address and ignores bait echoes", () => {
    const replay = new ReplayProvider();
    for (const [, conv] of replay.fixtures) {
      const ex = extractFromConversation(conv);
      expect(ex.addresses.length).toBeGreaterThan(0);
      expect(ex.phones.length + ex.telegrams.length).toBeGreaterThan(0);
    }
    expect(replay.fixtures.size).toBe(3);
  });
});
