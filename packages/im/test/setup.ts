import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// every test file gets its own data dir; never touch the repo's data/
process.env.BAITNET_DATA_DIR = mkdtempSync(join(tmpdir(), "baitnet-im-test-"));
process.env.BAITNET_MODE = "offline";
process.env.BAITNET_IM_DELAY_SCALE = "0";
delete process.env.BAITNET_EVIDENCE_KEY;
delete process.env.NEARAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.BAITNET_LLM;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.BAITNET_ONCHAIN_LOOKUP; // D33: never hit public RPC / TronGrid in tests
