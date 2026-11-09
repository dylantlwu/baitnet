import { existsSync, readFileSync } from "node:fs";
import {
  ChainRegistryClient,
  MemoryRegistryClient,
  type NearKey,
  type RegistryClient,
} from "@baitnet/guard";
import { dataPath } from "./paths.js";

export interface RuntimeAccount extends NearKey {
  keyKind?: string;
  name?: string;
}

/** data/runtime.json, written by the ops demo script after deploying (docs §4). */
export interface RuntimeConfig {
  network: "sandbox" | "testnet";
  rpcUrl: string;
  registryContract: string;
  vaultContract?: string;
  accounts: {
    owner?: RuntimeAccount;
    reporter: RuntimeAccount;
    agent?: RuntimeAccount;
    responders?: (RuntimeAccount & { name: string })[];
  };
}

export class RuntimeMissingError extends Error {
  constructor(path: string, detail?: string) {
    super(
      [
        `BaitNet runtime config not found or invalid: ${path}${detail ? ` (${detail})` : ""}`,
        "",
        "This file is written by the ops demo script after it starts the NEAR sandbox and deploys",
        "contracts/registry (+ vault). Fix it by either:",
        "  1. running the full demo:   pnpm demo            (starts sandbox, deploys, writes data/runtime.json)",
        "  2. or using the in-memory registry (no chain):   BAITNET_REGISTRY=memory pnpm --filter @baitnet/agent run demo-flow",
        "",
        "Expected shape: see docs/01_功能模块.md §4 (network, rpcUrl, registryContract, vaultContract, accounts.reporter/agent/responders).",
      ].join("\n"),
    );
    this.name = "RuntimeMissingError";
  }
}

export function runtimePath(): string {
  return process.env.BAITNET_RUNTIME ?? dataPath("runtime.json");
}

export function loadRuntime(path = runtimePath()): RuntimeConfig {
  if (!existsSync(path)) throw new RuntimeMissingError(path);
  let cfg: RuntimeConfig;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  } catch (e) {
    throw new RuntimeMissingError(path, `not valid JSON: ${(e as Error).message}`);
  }
  const missing = [
    !cfg.rpcUrl && "rpcUrl",
    !cfg.registryContract && "registryContract",
    !cfg.accounts?.reporter?.accountId && "accounts.reporter.accountId",
    !cfg.accounts?.reporter?.privateKey && "accounts.reporter.privateKey",
  ].filter(Boolean);
  if (missing.length) throw new RuntimeMissingError(path, `missing ${missing.join(", ")}`);
  return cfg;
}

export function useMemoryRegistry(): boolean {
  return process.env.BAITNET_REGISTRY === "memory";
}

export const MEMORY_REPORTER = "reporter.memory";

export interface Env {
  mode: "chain" | "memory";
  network: "sandbox" | "testnet" | "memory";
  runtime?: RuntimeConfig;
  /** Registry signed by the reporter account. */
  registry: RegistryClient;
  /** Registry client signed by another account (responders). */
  registryAs(acc: NearKey): RegistryClient;
}

/**
 * Chain mode needs data/runtime.json. Memory mode (BAITNET_REGISTRY=memory)
 * uses a file-backed in-memory registry at data/memory-registry.json so the
 * agent CLI and the server see the same state without a sandbox.
 */
export function loadEnv(): Env {
  if (useMemoryRegistry()) {
    const reg = new MemoryRegistryClient({ caller: MEMORY_REPORTER, persistPath: dataPath("memory-registry.json"), contractId: "registry.memory" });
    return { mode: "memory", network: "memory", registry: reg, registryAs: (a) => reg.as(a.accountId) };
  }
  const rt = loadRuntime();
  const reg = new ChainRegistryClient(rt.rpcUrl, rt.registryContract, rt.accounts.reporter);
  return { mode: "chain", network: rt.network, runtime: rt, registry: reg, registryAs: (a) => reg.as(a) };
}
