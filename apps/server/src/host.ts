/** Listen address: HOST env wins; production defaults to loopback (Caddy terminates TLS in front). */
export function listenHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HOST) return env.HOST;
  return env.NODE_ENV === "production" ? "127.0.0.1" : undefined; // undefined = all interfaces (dev)
}
