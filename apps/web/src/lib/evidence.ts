import { API, type AlertView, type Conversation } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { sha256Hex } from "./sha256";

export interface EvidenceCheck {
  status: "match" | "mismatch" | "unavailable";
  computed?: string;
  expected: string;
  /** bundle = snapshot evidence; server = GET /alerts/:id/evidence; conversation = canonical JSON fallback. */
  source: "bundle" | "server" | "conversation" | "none" | "error";
  detail?: string;
  bytes?: number;
}

/** AlertView has no conversationId, so link alert -> conversation by the address appearing in the chat. */
export function conversationFor(alert: AlertView, convs: Conversation[]): Conversation | undefined {
  if (alert.conversationId) {
    const c = convs.find((x) => x.id === alert.conversationId);
    if (c) return c;
  }
  const needle = alert.address.toLowerCase();
  return convs.find((c) => c.turns.some((t) => t.text.toLowerCase().includes(needle)));
}

async function fromServer(apiBase: string, id: number): Promise<string | undefined> {
  const res = await fetch(apiBase + API.evidence(id), { credentials: "include" });
  if (!res.ok) return undefined;
  const text = await res.text();
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      for (const k of ["plaintext", "evidence", "data"]) if (typeof o[k] === "string") return o[k] as string;
    }
  } catch {
    /* body is the plaintext itself */
  }
  return text;
}

/**
 * Recompute sha256 over the plaintext evidence in the browser and compare with the on-chain hash.
 * Plaintext sources, in order: snapshot.evidence[id] -> GET /alerts/:id/evidence -> JSON.stringify(conversation).
 */
export async function verifyEvidence(
  alert: AlertView,
  snap: ViewSnapshot,
  apiBase: string | null,
): Promise<EvidenceCheck> {
  const expected = alert.evidenceHash;
  const candidates: { source: EvidenceCheck["source"]; detail?: string; get: () => Promise<string | undefined> }[] = [];
  if (snap.evidence?.[alert.id] !== undefined)
    candidates.push({ source: "bundle", get: async () => snap.evidence?.[alert.id] });
  if (apiBase !== null) candidates.push({ source: "server", detail: `GET ${API.evidence(alert.id)}`, get: () => fromServer(apiBase, alert.id).catch(() => undefined) });
  const conv = conversationFor(alert, snap.conversations);
  if (conv) candidates.push({ source: "conversation", detail: conv.id, get: async () => JSON.stringify(conv) });

  let last: EvidenceCheck = { status: "unavailable", expected, source: "none" };
  for (const c of candidates) {
    const text = await c.get();
    if (text === undefined) continue;
    const computed = await sha256Hex(text);
    const r: EvidenceCheck = {
      status: computed === expected ? "match" : "mismatch",
      computed, expected, source: c.source, detail: c.detail, bytes: new TextEncoder().encode(text).length,
    };
    if (r.status === "match") return r;
    last = r;
  }
  return last;
}
