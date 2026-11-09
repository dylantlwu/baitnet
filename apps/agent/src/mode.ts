/**
 * Network policy (D8). BAITNET_MODE is set by scripts/demo.ts:
 *   offline (default for `pnpm demo`) / testnet → no internet calls at all:
 *     LLM = replay, Intents Explorer / 1Click = fixtures, attestation = recorded fixture.
 *     (NEAR RPC to the configured rpcUrl is still used: local sandbox, or testnet in testnet mode.)
 *   live → LLM by keys (nearai → claude → replay), Explorer if INTENTS_EXPLORER_JWT,
 *     1Click if LIVE_INTENTS=1, attestation fetched live (falls back to the recording).
 *   unset (running the CLI directly) → "auto": LLM/Explorer only if keys are present
 *     (no key → no request); attestation stays offline unless BAITNET_LIVE_ATTESTATION=1.
 */
export type NetworkMode = "offline" | "live" | "auto";

export function networkMode(env: NodeJS.ProcessEnv = process.env): NetworkMode {
  const m = env.BAITNET_MODE;
  if (m === "live") return "live";
  if (m === "offline" || m === "testnet" || env.BAITNET_OFFLINE === "1") return "offline";
  return "auto";
}

export function allowLiveLLM(env: NodeJS.ProcessEnv = process.env): boolean {
  return networkMode(env) !== "offline";
}

export function allowLiveIntents(env: NodeJS.ProcessEnv = process.env): boolean {
  return networkMode(env) !== "offline";
}

/** Attestation needs no key, so it only goes online when explicitly asked. */
export function allowLiveAttestation(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BAITNET_OFFLINE === "1") return false;
  return env.BAITNET_LIVE_ATTESTATION === "1" || networkMode(env) === "live";
}
