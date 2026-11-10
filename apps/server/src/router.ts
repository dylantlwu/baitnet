import type { IncomingMessage, ServerResponse } from "node:http";

/** Contract documented in docs/dev/server-routes.md (B2 registers training / scriptlab routes on it). */
export interface RouteRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  raw: IncomingMessage;
  res: ServerResponse;
  /**
   * Caller identity (local reviewer when BAITNET_AUTH is off). `id` = expertId: the training / scriptlab
   * routes (packages/training AuthUser) read `req.user.id`.
   */
  user?: { expertId: string; id?: string; name: string; role: "expert" | "reviewer" };
}
export type RouteHandler = (req: RouteRequest) => unknown | Promise<unknown>;

export interface RouteContext {
  log: (line: string) => void;
  dataPath: (...p: string[]) => string;
  /** RegistryClient (or a getter) for routes that report on chain after human review. */
  registry?: unknown;
  rpcUrl?: string;
}

/** Return this from a handler that wrote the response itself (e.g. SSE). */
export const HANDLED = Symbol("handled");

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

interface Route {
  method: string;
  path: string;
  re: RegExp;
  keys: string[];
  h: RouteHandler;
}

export class Router {
  private routes: Route[] = [];
  get(path: string, h: RouteHandler) {
    this.add("GET", path, h);
  }
  post(path: string, h: RouteHandler) {
    this.add("POST", path, h);
  }
  private add(method: string, path: string, h: RouteHandler) {
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        path.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === ":" ? c : `\\${c}`)).replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "/?$",
    );
    this.routes.push({ method, path: path.replace(/\/+$/, "") || "/", re, keys, h });
  }
  /** Find a route; `null` if the path is unknown, `"method"` if the path exists for another method. */
  match(method: string, path: string): { h: RouteHandler; params: Record<string, string>; pattern: string } | null | "method" {
    let pathOnly = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.method !== method) {
        pathOnly = true;
        continue;
      }
      return { h: r.h, pattern: r.path, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
    }
    return pathOnly ? "method" : null;
  }
  list(): string[] {
    return this.routes.map((r) => `${r.method} ${r.re.source}`);
  }
}

export const MAX_BODY = 25 * 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<any> {
  if (req.method !== "POST" && req.method !== "PUT") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw httpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "body must be JSON");
  }
}
