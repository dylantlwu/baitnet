import { exportTraining } from "./export.js";

const r = exportTraining();
console.log(`[training:export] ${r.sft} SFT sample(s) → ${r.sftFile}`);
console.log(`[training:export] ${r.preference} preference pair(s) → ${r.prefFile}`);
console.log("[training:export] bait side only (D15): scammer lines appear only as context, never as targets.");
