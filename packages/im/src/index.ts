import { dataPath } from "@baitnet/agent";
import { SessionRouter } from "./router.js";
import { ImState } from "./state.js";
import { TelegramAdapter } from "./telegram/adapter.js";
import type { ChannelAdapter, ImDeps } from "./types.js";

export * from "./types.js";
export * from "./state.js";
export * from "./i18n.js";
export * from "./humanize.js";
export * from "./router.js";
export * from "./memory-identity.js";
export * from "./telegram/api.js";
export * from "./telegram/adapter.js";
export { scriptlabFromModules } from "./wiring.js";

export interface ImHandle {
  stop(): Promise<void>;
  /** set when running */
  router?: SessionRouter;
  adapter?: ChannelAdapter;
  bot?: { username?: string };
}

/**
 * Start the IM training desk (Telegram). No-op when TELEGRAM_BOT_TOKEN is unset.
 * Never throws for network trouble at boot: polling retries on its own; only a
 * rejected token (401) disables the bot (logged, without the token).
 */
export async function startIm(deps: ImDeps): Promise<ImHandle> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s: string) => console.log(s));
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!deps.adapter && !token) {
    log("[im] TELEGRAM_BOT_TOKEN not set — IM training desk disabled");
    return { stop: async () => {} };
  }
  const state = new ImState(deps.stateFile ?? dataPath("im", "state-telegram.json"));
  let adapter: ChannelAdapter;
  try {
    adapter =
      deps.adapter ??
      new TelegramAdapter({
        token: token!,
        apiBase: deps.telegramApiBase ?? env.TELEGRAM_API_BASE,
        log,
        pollTimeoutSec: env.BAITNET_IM_POLL_SEC ? Number(env.BAITNET_IM_POLL_SEC) : undefined,
        mediaGroupWaitMs: env.BAITNET_IM_MEDIA_GROUP_MS ? Number(env.BAITNET_IM_MEDIA_GROUP_MS) : undefined,
        offset: { load: () => state.data.offset, save: (n) => state.update((d) => void (d.offset = n)) },
      });
  } catch (e) {
    log(`[im] ${(e as Error).message} — IM disabled`);
    return { stop: async () => {} };
  }
  const router = new SessionRouter({ ...deps, log }, adapter, state);
  let bot: { username?: string } | undefined;
  try {
    bot = await adapter.me();
    log(`[im] telegram bot @${bot.username ?? "?"} ready (long polling)`);
  } catch (e) {
    const code = (e as { code?: number }).code;
    log(`[im] getMe failed: ${(e as Error).message}`);
    if (code === 401 || code === 404) return { stop: async () => {} };
  }
  void router.setup().catch((e) => log(`[im] setMyCommands failed: ${(e as Error).message}`));
  await adapter.start(router.handlers());
  router.startTimers(Number(env.BAITNET_IM_TICK_MS ?? 60_000));
  return {
    router,
    adapter,
    bot,
    async stop() {
      await adapter.stop();
      await router.stop();
    },
  };
}
