import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// every test file gets its own data dir; never touch the repo's data/
process.env.BAITNET_DATA_DIR = mkdtempSync(join(tmpdir(), "baitnet-test-"));
delete process.env.BAITNET_EVIDENCE_KEY;
delete process.env.NEARAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.BAITNET_LLM;
