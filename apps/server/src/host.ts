/**
 * Listen address: HOST env wins.
 * - Railway (RAILWAY_ENVIRONMENT set): all interfaces — Railway's edge proxy must reach $PORT.
 * - other production (VPS behind Caddy): loopback, Caddy terminates TLS in front.
 * - dev: undefined = all interfaces.
 */
export function listenHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HOST) return env.HOST;
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME) return "0.0.0.0";
  return env.NODE_ENV === "production" ? "127.0.0.1" : undefined;
}
