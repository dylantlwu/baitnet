import type { Chain, Target } from "@baitnet/shared";

/**
 * Mirrors `normalize_address` in contracts/registry/src/lib.rs so the local
 * cache key matches the on-chain `latest_by_target` key exactly.
 */
export function normalizeAddress(chain: Chain, raw: string): string {
  const s = raw.trim();
  if (!s || s.length > 128) throw new Error(`bad address: ${raw}`);
  switch (chain) {
    case "evm": {
      const lower = s.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error(`bad evm address: ${raw}`);
      return lower;
    }
    case "near": {
      const lower = s.toLowerCase();
      if (!isValidNearAccount(lower)) throw new Error(`bad near account: ${raw}`);
      return lower;
    }
    case "btc": {
      if (!/^[0-9a-zA-Z]+$/.test(s)) throw new Error(`bad btc address: ${raw}`);
      const lower = s.toLowerCase();
      return /^(bc1|tb1|bcrt1)/.test(lower) ? lower : s;
    }
    case "tron": {
      if (!/^[0-9a-zA-Z]+$/.test(s)) throw new Error(`bad tron address: ${raw}`);
      return s;
    }
  }
}

/** NEAR account id rules (nearcore `AccountId::validate`). */
export function isValidNearAccount(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

export function targetKey(t: Target): string {
  return `${t.chain}:${normalizeAddress(t.chain, t.address)}`;
}

/** Same as targetKey but never throws (returns raw key for malformed input). */
export function safeTargetKey(t: Target): string {
  try {
    return targetKey(t);
  } catch {
    return `${t.chain}:${t.address.trim()}`;
  }
}
