/** Records one real attestation report (+ external verifier results) into fixtures/attestation/sample-report.json. */
import { writeFileSync } from "node:fs";
import { fixturePath } from "@baitnet/agent";
import { ATTESTATION_URL, DEFAULT_ATTEST_MODEL, fetchReport, newNonce, verifyReport, type RecordedFixture } from "./attestation.js";

const model = process.argv[2] ?? DEFAULT_ATTEST_MODEL;
const nonce = newNonce();
const report = await fetchReport(model, nonce);
const { checks, external } = await verifyReport(report, nonce, model, { online: true });
for (const c of checks) console.log(`${c.pass ? "✓" : "✗"} ${c.name} — ${c.detail}`);
const out: RecordedFixture = {
  recorded: { at: new Date().toISOString(), model, nonce, url: ATTESTATION_URL, ...external, note: "Real response recorded once for offline mode (served with recorded: true)." },
  report,
};
writeFileSync(fixturePath("attestation", "sample-report.json"), JSON.stringify(out));
console.log("saved", fixturePath("attestation", "sample-report.json"));
