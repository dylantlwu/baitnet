import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { REPO_ROOT } from "@baitnet/agent";

/** Production: serve the built dashboard (apps/web/dist) from the same port as the API. */
export const webDist = () => resolve(process.env.BAITNET_WEB_DIST ?? join(REPO_ROOT, "apps", "web", "dist"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Returns true if it served something. SPA fallback: unknown extension-less paths → index.html. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const root = webDist();
  if (!existsSync(join(root, "index.html"))) return false;
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  } catch {
    return false;
  }
  let file = join(root, rel);
  if (!file.startsWith(root + sep) && file !== root) return false; // path traversal
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) return false; // missing asset → 404 from caller
    file = join(root, "index.html");
  }
  const ext = extname(file).toLowerCase();
  const immutable = /\/assets\//.test(file) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : immutable, "content-length": statSync(file).size });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}

/** Headers for SSE that survive reverse proxies (Caddy/nginx): no buffering, no transform. */
export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;
