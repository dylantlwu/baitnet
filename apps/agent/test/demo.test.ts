import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RuntimeMissingError, loadEnv, loadRuntime } from "../src/runtime.js";
import { demoFlow, fullDemo, makeCtx } from "../src/demo.js";
import { readEvents, readConversations, readFlows, readAckReceipts } from "../src/store.js";
import { ReplayProvider } from "../src/llm/provider.js";
import { dataPath } from "../src/paths.js";

const quiet = () => {};

describe("runtime", () => {
  it("gives a clear error without data/runtime.json", () => {
    delete process.env.BAITNET_REGISTRY;
    expect(() => loadRuntime(dataPath("nope.json"))).toThrow(RuntimeMissingError);
    expect(() => loadEnv()).toThrow(/pnpm demo|BAITNET_REGISTRY=memory/);
  });
});

describe("demo (memory registry)", () => {
  it("P0 demo-flow: report → guard block → GuardEvent", async () => {
    process.env.BAITNET_REGISTRY = "memory";
    const r = await demoFlow(makeCtx(quiet));
    expect(r.event.verdict.kind).toBe("block");
    expect(r.event.action).toBe("refused");
    expect(readEvents().at(-1)!.id).toBe(r.event.id);
    expect(existsSync(dataPath("memory-registry.json"))).toBe(true);
  });
  it("full ①–⑥ demo produces alerts, events, flows, acks", async () => {
    process.env.BAITNET_REGISTRY = "memory";
    const { alerts, events } = await fullDemo(makeCtx(quiet), { llm: new ReplayProvider() });
    expect(alerts.filter((a) => a.level === "L1").length).toBeGreaterThanOrEqual(5);
    expect(alerts.filter((a) => a.level === "L2").length).toBe(3);
    expect(events.map((e) => e.action)).toEqual(["signed", "signed", "refused", "quoted", "quote-refused", "quote-refused", "quoted"]);
    expect(readConversations()).toHaveLength(3);
    expect(JSON.stringify(readConversations())).not.toMatch(/7700 900461|lin_yuqing88/);
    expect(Object.values(readFlows()).flat().length).toBeGreaterThan(0);
    expect(readAckReceipts().length).toBeGreaterThan(0);
  });
});
