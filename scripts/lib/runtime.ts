/**
 * data/runtime.json (docs/01_功能模块.md §4): shape + building it from env vars (testnet).
 * Shared by scripts/demo.ts (testnet/live modes) and scripts/write-runtime.ts (production service).
 */
import type { KeyedAccount } from "./near.ts";

export interface RuntimeJson {
  network: "sandbox" | "testnet";
  rpcUrl: string;
  registryContract: string;
  vaultContract: string;
  accounts: {
    owner: KeyedAccount;
    reporter: KeyedAccount;
    agent: KeyedAccount & { keyKind: string };
    responders: (KeyedAccount & { name: string })[];
  };
}

/** Throws one error listing every missing variable. */
export function testnetRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env, source = ".env"): RuntimeJson {
  const missing: string[] = [];
  const need = (name: string) => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? "";
  };
  const keyed = (prefix: string): KeyedAccount => ({
    accountId: need(`${prefix}_ACCOUNT_ID`),
    privateKey: need(`${prefix}_PRIVATE_KEY`) as KeyedAccount["privateKey"],
  });
  const responders: RuntimeJson["accounts"]["responders"] = [];
  for (const i of [1, 2, 3, 4]) {
    if (!env[`RESPONDER${i}_ACCOUNT_ID`]) continue;
    responders.push({ ...keyed(`RESPONDER${i}`), name: env[`RESPONDER${i}_NAME`] || `Responder${i}` });
  }
  const rt: RuntimeJson = {
    network: "testnet",
    rpcUrl: env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
    registryContract: need("REGISTRY_CONTRACT_ID"),
    vaultContract: need("VAULT_CONTRACT_ID"),
    accounts: {
      owner: keyed("OWNER"),
      reporter: keyed("REPORTER"),
      agent: { ...keyed("AGENT"), keyKind: "function-call:vault:pay" },
      responders,
    },
  };
  if (missing.length) throw new Error(`${source} 缺少 ${missing.join(", ")}（见 .env.example / deploy/env.production.example）`);
  return rt;
}
