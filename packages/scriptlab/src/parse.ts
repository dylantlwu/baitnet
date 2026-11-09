import type { ScamScriptDef, ScriptUpload, UploadFormat } from "@baitnet/shared";

export interface ParsedMessage {
  speaker?: string;
  text: string;
  ts?: string;
}

export interface ParsedUpload {
  format: UploadFormat;
  messages: ParsedMessage[];
  /** set for scam-script-json */
  script?: ScamScriptDef;
  /** set for image */
  image?: { mediaType: string; base64: string };
  notes: string[];
}

export class ScriptLabError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad-upload",
  ) {
    super(message);
  }
}

const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

function imageMediaType(upload: ScriptUpload): string | undefined {
  const ext = upload.filename.toLowerCase().split(".").pop() ?? "";
  if (IMAGE_EXT[ext]) return IMAGE_EXT[ext];
  if (upload.encoding !== "base64") return undefined;
  const head = Buffer.from(upload.content.slice(0, 32), "base64");
  if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 4).toString() === "RIFF") return "image/webp";
  if (head.subarray(0, 3).toString() === "GIF") return "image/gif";
  return undefined;
}

// WhatsApp exports:
//   iOS:     [12/10/2026, 21:03:15] Name: text
//   Android: 12/10/2026, 21:03 - Name: text    (also "10/12/26, 9:03 PM - Name: text")
const WA_IOS = /^‎?\[(\d{1,4}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?)\]\s*([^:]{1,60}?):\s?(.*)$/;
const WA_ANDROID = /^‎?(\d{1,4}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?)\s+[-–]\s+([^:]{1,60}?):\s?(.*)$/;
// Generic chat txt: optional [time] / 【time】 / bare "2026-10-12 21:03", then "Name：text" or "Name: text"
// Generic chat txt: optional 【anything ≤30】/[anything] (e.g. 【昨天 21:03】) or bare "2026-10-12 21:03" / "21:03", then "Name：text" or "Name: text"
const GENERIC =
  /^\s*(?:[[【]\s*(?<ts1>[^\]】]{1,30}?)\s*[\]】]\s*|[(（]?(?<ts2>\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+|\s*T)?\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)[)）]?\s+)?(?<sp>(?!\d+[:：])[^\s:：，,。【】[\]]{1,20}|[A-Za-z][\w .'|-]{0,30}?)\s*[:：](?!\/\/)\s*(?<tx>.+)$/;

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function parseLineChat(text: string, re: RegExp[], tsName = true): { msgs: ParsedMessage[]; matched: number; nonEmpty: number } {
  const msgs: ParsedMessage[] = [];
  let matched = 0;
  let nonEmpty = 0;
  for (const raw of lines(text)) {
    const l = raw.trim();
    if (!l) continue;
    nonEmpty++;
    let m: RegExpMatchArray | null = null;
    for (const r of re) if ((m = l.match(r))) break;
    if (m) {
      matched++;
      if (m.groups?.sp) msgs.push({ ts: (m.groups.ts1 ?? m.groups.ts2)?.trim() || undefined, speaker: m.groups.sp.trim(), text: m.groups.tx!.trim() });
      else if (tsName && m.length >= 5) msgs.push({ ts: `${m[1]} ${m[2]}`, speaker: m[3]!.trim(), text: m[4]!.trim() });
      else msgs.push({ ts: m[1]?.trim() || undefined, speaker: m[2]!.trim(), text: m[3]!.trim() });
    } else if (msgs.length) msgs.at(-1)!.text += `\n${l}`;
    else msgs.push({ text: l });
  }
  return { msgs, matched, nonEmpty };
}

function isScamScriptDef(x: unknown): x is ScamScriptDef {
  const o = x as ScamScriptDef;
  return !!o && typeof o === "object" && typeof o.type === "string" && Array.isArray(o.stages) && typeof o.hook === "string";
}

type TgText = string | { type?: string; text?: string } | (string | { type?: string; text?: string })[];
function tgText(t: TgText | undefined): string {
  if (t == null) return "";
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("");
  return t.text ?? "";
}

/** Detect format and normalize into messages (one message per transcript line). */
export function parseUpload(upload: ScriptUpload): ParsedUpload {
  if (!upload || typeof upload.content !== "string" || typeof upload.filename !== "string") throw new ScriptLabError("body must be a ScriptUpload {filename, content, encoding, expertId}");
  const notes: string[] = [];
  const media = imageMediaType(upload);
  if (media) return { format: "image", messages: [], image: { mediaType: media, base64: upload.content.replace(/^data:[^,]+,/, "") }, notes };
  const text = upload.encoding === "base64" ? Buffer.from(upload.content, "base64").toString("utf8") : upload.content;
  if (!text.trim()) throw new ScriptLabError("empty upload");
  const ext = upload.filename.toLowerCase().split(".").pop() ?? "";
  const trimmed = text.trim();

  if (ext === "json" || /^[{[]/.test(trimmed)) {
    let j: unknown;
    try {
      j = JSON.parse(trimmed);
    } catch {
      if (ext === "json") throw new ScriptLabError("invalid JSON");
    }
    if (j !== undefined) {
      if (isScamScriptDef(j)) {
        const s = j;
        const messages: ParsedMessage[] = [{ speaker: "scammer", text: s.hook }];
        for (const st of s.stages) for (const l of st.sampleLines ?? []) messages.push({ speaker: "scammer", text: l });
        for (const o of s.objections ?? []) {
          messages.push({ speaker: "victim", text: o.victimSays });
          for (const c of o.scammerCounters ?? []) messages.push({ speaker: "scammer", text: c });
        }
        for (const inj of s.injections ?? []) messages.push({ speaker: "scammer", text: inj });
        return { format: "scam-script-json", messages, script: s, notes };
      }
      const msgs = (j as { messages?: unknown }).messages;
      if (Array.isArray(msgs)) {
        const out: ParsedMessage[] = [];
        for (const m of msgs as { type?: string; from?: string; actor?: string; text?: TgText; date?: string }[]) {
          if (m.type && m.type !== "message") continue;
          const t = tgText(m.text).trim();
          if (!t) continue;
          out.push({ speaker: m.from ?? m.actor ?? "unknown", text: t, ts: m.date });
        }
        if (!out.length) throw new ScriptLabError("Telegram export has no text messages");
        return { format: "telegram-json", messages: out, notes };
      }
      throw new ScriptLabError("JSON is neither a ScamScriptDef nor a Telegram export (messages[].from/text)");
    }
  }

  const wa = parseLineChat(text, [WA_IOS, WA_ANDROID]);
  if (wa.matched >= 2 && wa.matched >= wa.nonEmpty * 0.5) {
    // drop WhatsApp system lines ("Messages and calls are end-to-end encrypted", "<Media omitted>")
    const msgs = wa.msgs.filter((m) => m.speaker && !/end-to-end encrypted|端到端加密/i.test(m.text)).map((m) => ({ ...m, text: m.text.replace(/<Media omitted>|<附件：.*?>/g, "[media]") }));
    return { format: "whatsapp-txt", messages: msgs, notes };
  }

  const isMd = ext === "md" || ext === "markdown" || /^#{1,6}\s/m.test(text);
  const generic = parseLineChat(
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*>]\s+|\*\*)/, "").replace(/\*\*([^*]+)\*\*\s*[:：]/, "$1："))
      .join("\n"),
    [GENERIC],
    false,
  );
  const speakers = new Set(generic.msgs.map((m) => m.speaker).filter(Boolean));
  if (generic.matched >= 2 && generic.matched >= generic.nonEmpty * 0.5 && speakers.size >= 2 && speakers.size <= 8) {
    return { format: isMd ? "markdown" : "text", messages: generic.msgs.filter((m) => !/^#{1,6}\s/.test(m.text)), notes };
  }
  // unstructured prose: one message per non-empty line, no speakers
  notes.push("no-speakers");
  const msgs = lines(text)
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim())
    .filter(Boolean)
    .map((t) => ({ text: t }));
  return { format: isMd ? "markdown" : "text", messages: msgs, notes };
}
