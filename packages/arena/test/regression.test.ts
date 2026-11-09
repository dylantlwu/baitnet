import { describe, expect, it } from "vitest";
import { runEval, tryImport, loadFixtureScripts } from "../src/index.js";

describe("eval + B2 regression cases", () => {
  it("approved correction → regression case → bait next reply judged → eval run recorded", async () => {
    const t = (await tryImport("training")) as any;
    expect(typeof t?.addCorrection).toBe("function");
    const c = t.addCorrection({
      sessionId: "arena-test-1",
      turnIndex: 1,
      expertId: "expert-zh",
      scriptId: "pig-butchering-02",
      scamType: "pig-butchering",
      stage: 2,
      situation: "骗子说：宝贝你先转 500U 试试，转完截图给我",
      badReply: "好的我马上转",
      goodReply: "我现在在公司不方便，你先把收款地址和链发我，我晚上回家弄",
      rationale: "拖延并追问地址，不答应付款",
      tags: ["stalling", "ask-address"],
    });
    t.reviewCorrection(c.id, true, "dylan");
    const scripts = loadFixtureScripts().filter((s) => s.id === "pig-butchering-02");
    const r = await runEval({ scripts });
    expect(r.regression.total).toBeGreaterThanOrEqual(1);
    const rc = r.regression.cases.find((x) => x.id === c.id)!;
    expect(rc.reply).not.toBe("好的我马上转");
    expect(rc.pass).toBe(true);
    const runs = t.listEvalRuns();
    expect(runs.at(-1).summary.regressionTotal).toBeGreaterThanOrEqual(1);
  });
});
