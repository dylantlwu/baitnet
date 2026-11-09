/** Minimal NEAR JSON-RPC for read-only queries (no near-api-js needed for views). */

let rpcId = 0;

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown, timeoutMs = 8000): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `baitnet-${++rpcId}`, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: unknown } };
  if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error.cause ?? body.error.data ?? body.error.message)}`);
  if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) {
    throw new Error(`RPC ${method}: ${body.result.error}`);
  }
  return body.result as T;
}

export function rpcQuery<T>(rpcUrl: string, params: Record<string, unknown>): Promise<T> {
  return rpcCall<T>(rpcUrl, "query", params);
}

export async function viewFunction<T>(rpcUrl: string, contractId: string, methodName: string, args: unknown = {}): Promise<T> {
  const res = await rpcQuery<{ result: number[] }>(rpcUrl, {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const text = Buffer.from(res.result).toString("utf8");
  return (text ? JSON.parse(text) : null) as T;
}
