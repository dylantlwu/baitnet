import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chartTicks, LineChart } from "./components/LineChart";
import { visibleWhisper } from "./pages/ArenaPage";
import { snapshotNetwork, parseSnapshot } from "./data/parse";
import { translateTeeCheck, translateWarning } from "./i18n/vocab";
import { en } from "./i18n/en";
import { zh } from "./i18n/zh";
import { loadAttestation } from "./pages/TeePage";

describe("improvement curve", () => {
  it("count axes use distinct integer ticks", () => {
    for (const max of [1, 2, 3, 4, 5, 7, 12]) {
      const ticks = chartTicks(max, true);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
    expect(chartTicks(4, true)).toEqual([0, 1, 2, 3, 4]);
  });

  it("a version with no regression cases draws no point (not 0%)", () => {
    const html = renderToStaticMarkup(
      <LineChart
        title="t"
        yMax={100}
        yFmt={(v) => `${v}%`}
        xLabel={(x) => `v${x}`}
        emptyLabel="none"
        series={[{ key: "r", label: "r", color: "red", points: [{ x: 1, y: null }, { x: 2, y: 50 }, { x: 3, y: 100 }] }]}
      />,
    );
    expect(html.match(/<circle/g)).toHaveLength(2);
    expect(html.match(/<polyline/g)).toHaveLength(1);
  });
});

describe("whisper notice", () => {
  const w = { text: "ask chain", state: "sent" as const, atTurns: 3 };
  it("shows until the side speaks again, then disappears", () => {
    expect(visibleWhisper(w, 3)).toBe(w);
    expect(visibleWhisper(w, 4)).toBeNull();
    expect(visibleWhisper(null, 0)).toBeNull();
  });
  it("failures stay visible for retry", () => {
    const f = { ...w, state: "failed" as const };
    expect(visibleWhisper(f, 9)).toBe(f);
  });
});

describe("translations of backend vocab", () => {
  it("every safety rule code the backend emits has zh and en labels", () => {
    const rules = ["agree-pay", "agree-sign", "asks-for-address", "clicked-link", "differs-from-bad", "no-leak", "non-empty", "not-hijacked", "pii-bank-card", "pii-email", "pii-id-number", "pii-phone", "private-key", "seed-phrase"];
    for (const r of rules) {
      expect(zh, r).toHaveProperty(`rule.${r}`);
      expect(en, r).toHaveProperty(`rule.${r}`);
    }
  });
  it("every tactic tag the analyzer emits has a label", () => {
    const tags = ["rapport", "profit-lure", "platform-link", "payment-request", "small-test", "seed-phrase", "verification-code", "remote-access", "urgency", "fee-to-withdraw", "secrecy", "authority", "threat", "otc-exchange", "task-rebate", "injection", "stalling", "ask-address", "resist-injection"];
    for (const x of tags) expect(zh, x).toHaveProperty(`tag.${x}`);
  });
  it("English upload warnings are shown in Chinese and vice versa", () => {
    expect(translateWarning("No payment address found in the chat", "zh")).toBe("缺少收款地址：聊天记录里没有找到链上地址");
    expect(translateWarning("Low scam-type confidence (0.42); please confirm", "zh")).toContain("0.42");
    expect(translateWarning("3 injection line(s) found", "zh")).toBe("发现 3 句注入/诱导句，已列入注入句");
    expect(translateWarning("发现 2 句注入/诱导句，已列入 injections", "en")).toMatch(/^2 injection line/);
    expect(translateWarning("something unknown", "zh")).toBe("something unknown");
  });
  it("TEE check names are translated, keeping the model/gateway scope", () => {
    expect(translateTeeCheck("model: TDX quote parses", "zh")).toBe("模型：TDX quote 可以解析");
    expect(translateTeeCheck("gateway: Intel DCAP quote signature", "zh")).toBe("网关：Intel DCAP quote 签名有效");
    expect(translateTeeCheck("model attestation present", "zh")).toBe("模型证明报告存在");
    expect(translateTeeCheck("model: TDX quote parses", "en")).toBe("model: TDX quote parses");
  });
});

describe("snapshot network label", () => {
  it("reports the in-memory registry truthfully", () => {
    expect(snapshotNetwork("sandbox", "registry.memory")).toBe("memory");
    expect(snapshotNetwork("memory", "x")).toBe("memory");
    expect(snapshotNetwork("sandbox", "registry.test.near")).toBe("sandbox");
    expect(snapshotNetwork(undefined, "registry.baitnet.testnet")).toBe("testnet");
    expect(parseSnapshot({ alerts: [], network: "sandbox", registryContract: "registry.memory" }).network).toBe("memory");
  });
});

describe("TEE first open", () => {
  it("loads the attestation directly when the snapshot has none", async () => {
    const att = { model: "m", nonce: "n", checks: [{ name: "model: nonce echoed", pass: true, detail: "" }], verified: true, recorded: false, at: "t" };
    const f = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://x/attestation");
      expect(init?.credentials).toBe("include");
      return new Response(JSON.stringify(att));
    }) as unknown as typeof fetch;
    expect((await loadAttestation("http://x", f))?.checks).toHaveLength(1);
    const bad = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(await loadAttestation("http://x", bad)).toBeUndefined();
  });
});
