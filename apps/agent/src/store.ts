import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Conversation, FlowEdge, GuardEvent } from "@baitnet/shared";
import { dataPath } from "./paths.js";

function ensureDir(file: string) {
  mkdirSync(dirname(file), { recursive: true });
}

export function writeJson(file: string, value: unknown) {
  ensureDir(file);
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function appendJsonl(file: string, value: unknown) {
  ensureDir(file);
  appendFileSync(file, JSON.stringify(value) + "\n");
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

// ---- GuardEvents: data/events.jsonl (server tails it for SSE)
export const eventsFile = () => dataPath("events.jsonl");
export function appendEvent(e: GuardEvent) {
  appendJsonl(eventsFile(), e);
}
export function readEvents(): GuardEvent[] {
  return readJsonl<GuardEvent>(eventsFile());
}

// ---- Conversations (redacted copies only; full text lives in encrypted evidence)
export const conversationsDir = () => dataPath("conversations");
export function saveConversation(c: Conversation) {
  writeJson(dataPath("conversations", `${c.id}.json`), c);
}
export function readConversations(): Conversation[] {
  const dir = conversationsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<Conversation | null>(dataPath("conversations", f), null))
    .filter((c): c is Conversation => !!c);
}

// ---- Flows: data/flows.json keyed by alert id
export const flowsFile = () => dataPath("flows.json");
export function saveFlows(alertId: number, edges: FlowEdge[]) {
  const all = readJson<Record<string, FlowEdge[]>>(flowsFile(), {});
  all[String(alertId)] = edges;
  writeJson(flowsFile(), all);
}
export function readFlows(): Record<number, FlowEdge[]> {
  return readJson<Record<number, FlowEdge[]>>(flowsFile(), {});
}

// ---- Review / pipeline log
export const reviewLogFile = () => dataPath("review-log.jsonl");
export function appendReview(entry: Record<string, unknown>) {
  appendJsonl(reviewLogFile(), { at: new Date().toISOString(), ...entry });
}

// ---- Reported alerts index (tx hashes are not stored on chain; keep them locally)
export const reportsFile = () => dataPath("reports.json");
export interface ReportRecord {
  alertId: number;
  chain: string;
  address: string;
  txHash?: string;
  evidenceHash: string;
  conversationId: string;
  at: string;
}
export function saveReport(r: ReportRecord) {
  const all = readJson<ReportRecord[]>(reportsFile(), []);
  all.push(r);
  writeJson(reportsFile(), all);
}
export function readReports(): ReportRecord[] {
  return readJson<ReportRecord[]>(reportsFile(), []);
}

// ---- When a responder first saw an alert (off-chain; the contract only stores ack time)
export const ackReceiptsFile = () => dataPath("ack-receipts.json");
export interface AckReceipt {
  alertId: number;
  responder: string;
  receivedAt: string;
}
export function saveAckReceipt(r: AckReceipt) {
  const all = readJson<AckReceipt[]>(ackReceiptsFile(), []);
  if (!all.some((x) => x.alertId === r.alertId && x.responder === r.responder)) all.push(r);
  writeJson(ackReceiptsFile(), all);
}
export function readAckReceipts(): AckReceipt[] {
  return readJson<AckReceipt[]>(ackReceiptsFile(), []);
}
