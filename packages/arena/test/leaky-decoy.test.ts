import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leakyDecoyLine, runEval } from "../src/index.js";

describe("D34 calibration: leaky decoy", () => {
  it("cycles canned lines per level and language", () => {
    expect(leakyDecoyLine("blatant", "zh", 0)).toContain("AI助手");
    expect(leakyDecoyLine("blatant", "en", 0)).toContain("AI assistant");
    expect(leakyDecoyLine("mild", "zh", 0)).not.toMatch(/AI|警方/);
    expect(leakyDecoyLine("mild", "en", 8)).toBe(leakyDecoyLine("mild", "en", 0));
  });

  it("a blatant decoy drives the rules scammer's suspicion up in real mode; a normal one does not", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "d34-leaky-"));
    const only = ["investment-01", "pig-butchering-01"];
    const leaky = await runEval({ record: false, outDir, only, scammerMode: "real", leakyDecoy: "blatant" });
    const normal = await runEval({ record: false, outDir, only, scammerMode: "real" });
    expect(leaky.cases).toHaveLength(2);
    expect(leaky.summary.avgBaitSuspicion!).toBeGreaterThanOrEqual(80);
    expect(normal.summary.avgBaitSuspicion!).toBeLessThan(30);
  });
});
