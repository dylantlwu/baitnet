import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local fake of the Telegram Bot API (the subset the adapter uses), so the
 * whole bot can be driven end-to-end: tests inject user updates and read what
 * the bot sent / edited.
 */

export interface FakeUser {
  id: number;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface SentMessage {
  message_id: number;
  chat_id: string;
  text: string;
  reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][]; force_reply?: boolean };
  reply_to?: number;
  edits: number;
}

export class FakeTelegram {
  readonly token = "123456789:TEST-fake_token_do_not_log";
  private server?: Server;
  base = "";
  private updates: Record<string, unknown>[] = [];
  private nextUpdate = 1;
  private nextMsg = 1000;
  private waiters: (() => void)[] = [];
  readonly messages = new Map<number, SentMessage>();
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly files = new Map<string, { path: string; data: Buffer }>();
  readonly answers: { id: string; text?: string; show_alert?: boolean }[] = [];
  readonly commands: { lang?: string; commands: { command: string; description: string }[] }[] = [];
  /** make the next N getUpdates calls fail with a 502 (network jitter) */
  failPolls = 0;
  /** make the next N sendMessage calls fail with a 500 */
  failSends = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  async close() {
    for (const w of this.waiters.splice(0)) w();
    await new Promise<void>((r) => this.server?.close(() => r()));
    this.server?.closeAllConnections?.();
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    const fileM = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileM) {
      const f = [...this.files.values()].find((x) => x.path === fileM[2]);
      if (fileM[1] !== this.token || !f) return this.json(res, 404, { ok: false });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(f.data);
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return this.json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    if (m[1] !== this.token) return this.json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const params = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const method = m[2]!;
    this.calls.push({ method, params });
    const ok = (result: unknown) => this.json(res, 200, { ok: true, result });
    switch (method) {
      case "getMe":
        return ok({ id: 123456789, is_bot: true, first_name: "BaitNet 训练台", username: "baitnet_test_bot" });
      case "deleteWebhook":
        return ok(true);
      case "getUpdates": {
        if (this.failPolls > 0) {
          this.failPolls--;
          return this.json(res, 502, { ok: false, error_code: 502, description: "Bad Gateway" });
        }
        const offset = Number(params.offset ?? 0);
        const forced = this.updates.filter((u) => u._force);
        this.updates = this.updates.filter((u) => !u._force && (u.update_id as number) >= offset);
        if (forced.length) return ok([...forced, ...this.updates]);
        if (!this.updates.length) {
          const timeout = Math.min(Number(params.timeout ?? 0), 1) * 1000;
          await new Promise<void>((r) => {
            const t = setTimeout(r, timeout);
            this.waiters.push(() => (clearTimeout(t), r()));
          });
        }
        return ok(this.updates.filter((u) => (u.update_id as number) >= offset));
      }
      case "sendMessage": {
        if (this.failSends > 0) {
          this.failSends--;
          return this.json(res, 500, { ok: false, error_code: 500, description: "Internal Server Error" });
        }
        const msg: SentMessage = {
          message_id: this.nextMsg++,
          chat_id: String(params.chat_id),
          text: String(params.text),
          reply_markup: params.reply_markup as SentMessage["reply_markup"],
          reply_to: (params.reply_parameters as { message_id?: number } | undefined)?.message_id,
          edits: 0,
        };
        this.messages.set(msg.message_id, msg);
        return ok({ message_id: msg.message_id, chat: { id: Number(params.chat_id) }, text: msg.text });
      }
      case "editMessageText": {
        const msg = this.messages.get(Number(params.message_id));
        if (!msg) return this.json(res, 400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
        msg.text = String(params.text);
        msg.reply_markup = params.reply_markup as SentMessage["reply_markup"];
        msg.edits++;
        return ok(true);
      }
      case "editMessageReplyMarkup": {
        const msg = this.messages.get(Number(params.message_id));
        if (!msg) return this.json(res, 400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
        msg.reply_markup = params.reply_markup as SentMessage["reply_markup"];
        msg.edits++;
        return ok(true);
      }
      case "answerCallbackQuery":
        this.answers.push({ id: String(params.callback_query_id), text: params.text as string | undefined, show_alert: params.show_alert as boolean | undefined });
        return ok(true);
      case "sendChatAction":
        return ok(true);
      case "setMyCommands":
        this.commands.push({ lang: params.language_code as string | undefined, commands: params.commands as { command: string; description: string }[] });
        return ok(true);
      case "getFile": {
        const f = this.files.get(String(params.file_id));
        if (!f) return this.json(res, 400, { ok: false, error_code: 400, description: "Bad Request: invalid file_id" });
        return ok({ file_id: params.file_id, file_path: f.path, file_size: f.data.length });
      }
      default:
        return this.json(res, 404, { ok: false, error_code: 404, description: `fake: ${method} not implemented` });
    }
  }

  // ───────────── test drivers ─────────────

  private push(u: Record<string, unknown>, id = this.nextUpdate++) {
    this.updates.push({ update_id: id, ...u });
    for (const w of this.waiters.splice(0)) w();
    return id;
  }

  /** Re-deliver an update with an id that was already used (duplicate delivery). */
  pushRaw(u: Record<string, unknown>, updateId: number) {
    this.push({ ...u, _force: true }, updateId);
  }

  private msgBase(user: FakeUser, extra: Record<string, unknown> = {}) {
    return { message_id: this.nextMsg++, from: { ...user, is_bot: false }, chat: { id: user.id, type: "private" }, date: Math.floor(Date.now() / 1000), ...extra };
  }

  say(user: FakeUser, text: string, extra: Record<string, unknown> = {}): number {
    const message = this.msgBase(user, { text, ...extra });
    this.push({ message });
    return message.message_id as number;
  }

  sayInGroup(user: FakeUser, text: string) {
    this.push({ message: { ...this.msgBase(user, { text }), chat: { id: -100123, type: "group" } } });
  }

  photos(user: FakeUser, images: Buffer[], groupId = `g${Date.now()}`) {
    for (const [i, data] of images.entries()) {
      const fid = `photo_${groupId}_${i}`;
      this.files.set(fid, { path: `photos/file_${groupId}_${i}.jpg`, data });
      this.push({ message: this.msgBase(user, { media_group_id: images.length > 1 ? groupId : undefined, photo: [{ file_id: fid, file_unique_id: `u${fid}`, width: 1080, height: 2340, file_size: data.length }] }) });
    }
  }

  document(user: FakeUser, filename: string, data: Buffer, mime = "text/plain") {
    const fid = `doc_${filename}_${this.nextMsg}`;
    this.files.set(fid, { path: `documents/${filename}`, data });
    this.push({ message: this.msgBase(user, { document: { file_id: fid, file_name: filename, mime_type: mime, file_size: data.length } }) });
  }

  press(user: FakeUser, messageId: number, data: string): string {
    const id = `cb${this.nextUpdate}`;
    const msg = this.messages.get(messageId)!;
    this.push({ callback_query: { id, from: { ...user, is_bot: false }, data, message: { message_id: messageId, chat: { id: Number(msg.chat_id) } } } });
    return id;
  }

  // ───────────── assertions ─────────────

  sentTo(chatId: number | string): SentMessage[] {
    return [...this.messages.values()].filter((m) => m.chat_id === String(chatId));
  }

  buttons(m: SentMessage): { text: string; data: string }[] {
    return (m.reply_markup?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data }));
  }

  /** Wait until a message to `chatId` satisfies `pred` (after index `from`). */
  async waitFor(chatId: number | string, pred: (m: SentMessage) => boolean, timeoutMs = 8000, from = 0): Promise<SentMessage> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.sentTo(chatId).slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    const got = this.sentTo(chatId).map((m) => `#${m.message_id} ${m.text.slice(0, 80)}`).join("\n  ");
    throw new Error(`timeout waiting for message to ${chatId}; got:\n  ${got}`);
  }

  async waitAnswer(id: string, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const a = this.answers.find((x) => x.id === id);
      if (a) return a;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no answer for ${id}`);
  }

  /** Let the bot drain: resolves once no non-polling call happened for `ms`. */
  async settle(ms = 300) {
    const count = () => this.calls.filter((c) => c.method !== "getUpdates" && c.method !== "sendChatAction").length;
    let prev = -1;
    while (prev !== count()) {
      prev = count();
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
