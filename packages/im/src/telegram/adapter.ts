import type { BotCommand, Button, ButtonPress, ChannelAdapter, ChannelHandlers, FileRef, ImUser, InMessage, OutMessage } from "../types.js";
import { TelegramApi, TelegramError, sleep, type TelegramApiOptions } from "./api.js";

// ── the few Bot API shapes we read ──
interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string; language_code?: string }
interface TgPhoto { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: TgPhoto[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  media_group_id?: string;
  reply_to_message?: { message_id: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
}

export interface TelegramAdapterOptions extends TelegramApiOptions {
  /** long-poll timeout in seconds (Telegram max 50) */
  pollTimeoutSec?: number;
  /** wait this long after the last photo of a media group before handing it over */
  mediaGroupWaitMs?: number;
  /** persisted getUpdates offset (so a restart never re-handles an update) */
  offset?: { load(): number | undefined; save(n: number): void };
  /** max backoff after polling errors */
  maxBackoffMs?: number;
}

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Bot API getFile limit

const toUser = (u: TgUser): ImUser => ({
  externalId: String(u.id),
  username: u.username,
  displayName: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username,
  langCode: u.language_code,
});

const keyboard = (rows?: Button[][] | null) =>
  rows && rows.length ? { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.payload }))) } : { inline_keyboard: [] };

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Telegram via Bot API long polling (getUpdates) — no public webhook needed.
 * - update_id offset is persisted; a bounded set of recent ids guards against duplicates
 * - network errors back off exponentially (1 s → 30 s) and polling continues
 * - photos of one media group are merged into a single InMessage
 * - handlers run without blocking the poll loop (the router serialises per chat)
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram" as const;
  readonly api: TelegramApi;
  private running = false;
  private abort?: AbortController;
  private stopCtl = new AbortController();
  private loop?: Promise<void>;
  private offset = 0;
  private seen = new Set<number>();
  private seenOrder: number[] = [];
  private groups = new Map<string, { msgs: TgMessage[]; timer: NodeJS.Timeout }>();
  private inflight = new Set<Promise<unknown>>();
  private handlers?: ChannelHandlers;

  constructor(private opts: TelegramAdapterOptions) {
    this.api = new TelegramApi(opts);
  }

  private log(s: string) {
    this.opts.log?.(this.api.scrub(s));
  }

  async me() {
    const u = await this.api.call<TgUser>("getMe");
    return { username: u.username, name: u.first_name };
  }

  async start(h: ChannelHandlers): Promise<void> {
    if (this.running) return;
    this.handlers = h;
    this.running = true;
    this.stopCtl = new AbortController();
    this.offset = this.opts.offset?.load() ?? 0;
    // long polling and a webhook are exclusive; make sure no stale webhook blocks getUpdates
    try {
      await this.api.call("deleteWebhook", { drop_pending_updates: false });
    } catch (e) {
      this.log(`[im/telegram] deleteWebhook failed: ${(e as Error).message}`);
    }
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopCtl.abort();
    this.abort?.abort();
    await this.loop?.catch(() => {});
    for (const [id, g] of this.groups) {
      clearTimeout(g.timer);
      this.flushGroup(id);
    }
    await Promise.allSettled([...this.inflight]);
  }

  private markSeen(id: number): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 1000) this.seen.delete(this.seenOrder.shift()!);
    return true;
  }

  private async poll() {
    let backoff = 1000;
    const maxBackoff = this.opts.maxBackoffMs ?? 30_000;
    const timeout = this.opts.pollTimeoutSec ?? 25;
    while (this.running) {
      this.abort = new AbortController();
      const timer = setTimeout(() => this.abort?.abort(), (timeout + 15) * 1000);
      try {
        const updates = await this.api.raw<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset || undefined, timeout, allowed_updates: ["message", "callback_query"] },
          this.abort.signal,
        );
        backoff = 1000;
        for (const u of updates) {
          if (u.update_id < this.offset || !this.markSeen(u.update_id)) continue; // duplicate
          this.offset = u.update_id + 1;
          this.opts.offset?.save(this.offset); // at-most-once: commit before handling
          this.dispatch(u);
        }
      } catch (e) {
        if (!this.running) break;
        const err = e as TelegramError;
        if (err.code === 401 || err.code === 404) {
          this.log(`[im/telegram] ${err.message} — token rejected, polling stopped`);
          this.running = false;
          break;
        }
        const wait = err.retryAfter ? err.retryAfter * 1000 : backoff;
        this.log(`[im/telegram] getUpdates failed (${err.message}); retry in ${wait}ms`);
        await sleep(wait, this.stopCtl.signal);
        backoff = Math.min(backoff * 2, maxBackoff);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private track(p: Promise<unknown>) {
    const q = p.catch((e) => this.log(`[im/telegram] handler error: ${(e as Error)?.stack ?? e}`)).finally(() => this.inflight.delete(q));
    this.inflight.add(q);
  }

  private dispatch(u: TgUpdate) {
    const h = this.handlers!;
    if (u.callback_query) {
      const q = u.callback_query;
      if (!q.message || !q.data) {
        this.track(this.answerButton(q.id));
        return;
      }
      const press: ButtonPress = { chatId: String(q.message.chat.id), messageId: String(q.message.message_id), user: toUser(q.from), payload: q.data, pressId: q.id };
      this.track(Promise.resolve(h.onButton(press)));
      return;
    }
    const m = u.message;
    if (!m || !m.from || m.from.is_bot) return;
    if (m.media_group_id) {
      const g = this.groups.get(m.media_group_id);
      if (g) {
        clearTimeout(g.timer);
        g.msgs.push(m);
      }
      const entry = g ?? { msgs: [m], timer: undefined as unknown as NodeJS.Timeout };
      entry.timer = setTimeout(() => this.flushGroup(m.media_group_id!), this.opts.mediaGroupWaitMs ?? 1500);
      this.groups.set(m.media_group_id, entry);
      return;
    }
    this.track(Promise.resolve(h.onMessage(this.convert([m]))));
  }

  private flushGroup(id: string) {
    const g = this.groups.get(id);
    if (!g) return;
    this.groups.delete(id);
    g.msgs.sort((a, b) => a.message_id - b.message_id);
    this.track(Promise.resolve(this.handlers!.onMessage(this.convert(g.msgs))));
  }

  private convert(msgs: TgMessage[]): InMessage {
    const first = msgs[0]!;
    const images: FileRef[] = [];
    let file: FileRef | undefined;
    for (const m of msgs) {
      if (m.photo?.length) {
        // largest size that is still downloadable
        const p = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height).find((x) => (x.file_size ?? 0) <= MAX_DOWNLOAD_BYTES) ?? m.photo.at(-1)!;
        images.push({ id: p.file_id, filename: `photo-${m.message_id}.jpg`, mime: "image/jpeg", size: p.file_size, kind: "image" });
      }
      if (m.document) {
        const d = m.document;
        const ref: FileRef = { id: d.file_id, filename: d.file_name ?? `file-${m.message_id}`, mime: d.mime_type, size: d.file_size, kind: d.mime_type?.startsWith("image/") ? "image" : "document" };
        if (ref.kind === "image") images.push(ref);
        else file ??= ref;
      }
    }
    const text = msgs.map((m) => m.text ?? m.caption).find((t) => t !== undefined);
    return {
      chatId: String(first.chat.id),
      messageId: String(first.message_id),
      user: toUser(first.from!),
      isPrivate: first.chat.type === "private",
      ...(text !== undefined ? { text } : {}),
      ...(images.length ? { images } : {}),
      ...(file ? { file } : {}),
      ...(first.reply_to_message ? { replyToMessageId: String(first.reply_to_message.message_id) } : {}),
    };
  }

  // ───────────── outgoing ─────────────

  async send(chatId: string, m: OutMessage): Promise<{ messageId: string }> {
    const reply_markup = m.forceReply
      ? { force_reply: true, ...(m.forceReply.placeholder ? { input_field_placeholder: m.forceReply.placeholder.slice(0, 64) } : {}) }
      : m.buttons?.length
        ? keyboard(m.buttons)
        : undefined;
    const r = await this.api.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: clip(m.text),
      link_preview_options: { is_disabled: true },
      ...(reply_markup ? { reply_markup } : {}),
      ...(m.replyToMessageId ? { reply_parameters: { message_id: Number(m.replyToMessageId), allow_sending_without_reply: true } } : {}),
    });
    return { messageId: String(r.message_id) };
  }

  async typing(chatId: string): Promise<void> {
    try {
      await this.api.raw("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      /* cosmetic */
    }
  }

  async editButtons(chatId: string, messageId: string, buttons: Button[][] | null): Promise<void> {
    try {
      await this.api.call("editMessageReplyMarkup", { chat_id: chatId, message_id: Number(messageId), reply_markup: keyboard(buttons) });
    } catch (e) {
      if (!/not modified/i.test((e as Error).message)) throw e;
    }
  }

  async editMessage(chatId: string, messageId: string, m: OutMessage): Promise<void> {
    try {
      await this.api.call("editMessageText", {
        chat_id: chatId,
        message_id: Number(messageId),
        text: clip(m.text),
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard(m.buttons),
      });
    } catch (e) {
      if (!/not modified/i.test((e as Error).message)) throw e;
    }
  }

  async answerButton(pressId: string, toast?: string, alert = false): Promise<void> {
    try {
      await this.api.raw("answerCallbackQuery", { callback_query_id: pressId, ...(toast ? { text: toast.slice(0, 190), show_alert: alert } : {}) });
    } catch {
      /* query too old: harmless */
    }
  }

  async fetchFile(ref: FileRef) {
    if ((ref.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new TelegramError(`file too large (${ref.size} bytes > 20 MB)`, 413);
    const f = await this.api.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: ref.id });
    if (!f.file_path) throw new TelegramError("getFile returned no file_path");
    const data = await this.api.download(f.file_path);
    const ext = f.file_path.split(".").pop();
    const filename = ref.kind === "image" && ext && !/\.\w+$/.test(ref.filename) ? `${ref.filename}.${ext}` : ref.filename;
    return { filename, mime: ref.mime, data };
  }

  async setCommands(cmds: BotCommand[], lang?: string): Promise<void> {
    await this.api.call("setMyCommands", { commands: cmds, ...(lang ? { language_code: lang } : {}) });
  }
}
