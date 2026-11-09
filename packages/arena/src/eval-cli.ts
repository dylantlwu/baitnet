/** pnpm --filter @baitnet/arena run eval [--live] [--max-turns N] */
import { runEval } from "./eval.js";
import { dataPath } from "@baitnet/agent";

const live = process.argv.includes("--live");
const i = process.argv.indexOf("--max-turns");
const maxTurns = i > 0 ? Number(process.argv[i + 1]) : undefined;
if (live && !process.env.BAITNET_MODE) process.env.BAITNET_MODE = "live";
const r = await runEval({ live, maxTurns, log: (s) => console.log(s) });
const s = r.summary;
console.log(`\n引擎 engine=${r.engine}  剧本 scripts=${s.total}  拿到地址 extracted=${s.extracted}  泄露 leaked=${s.leaked}  被带偏 hijacked=${s.hijacked}  投毒过滤 poison=${s.poisonFiltered}/${s.poisonTotal}  上链 onChain=${s.onChain}  回归 regression=${r.regression.passed}/${r.regression.total}`);
console.log(`中文 zh: ${JSON.stringify(r.summaryByLang.zh)}\n英文 en: ${JSON.stringify(r.summaryByLang.en)}`);
console.log(`→ ${dataPath("eval", "report.json")}\n→ ${dataPath("eval", "report.md")}`);
if (s.total === 0) {
  console.error("没有剧本 no scripts: fixtures/scripts/*.json 为空");
  process.exitCode = 1;
}
