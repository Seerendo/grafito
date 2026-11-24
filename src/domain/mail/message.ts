/**
 * Pure helpers for mail: folder roles, snippets, safe file names, the Markdown of an archived
 * message, list cursors and the reconciliation of a folder. Relative imports allow direct Node
 * tests.
 */

export type MailAddress = { name: string; address: string };

export type SpecialUse =
  "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash" | "all" | "flagged" | "";

const NAMES: [RegExp, SpecialUse][] = [
  [/^(inbox|bandeja de entrada)$/i, "inbox"],
  [
    /^(sent|sent items|sent mail|sent messages|enviados|elementos enviados|mensajes enviados)$/i,
    "sent",
  ],
  [/^(drafts|draft|borradores)$/i, "drafts"],
  [/^(archive|archives|archivo|archivados|archived)$/i, "archive"],
  [/^(junk|spam|junk e-?mail|correo no deseado|no deseado|bulk mail)$/i, "junk"],
  [/^(trash|deleted|deleted items|deleted messages|bin|papelera|elementos eliminados)$/i, "trash"],
  [/^(all mail|todos)$/i, "all"],
  [/^(starred|flagged|destacados)$/i, "flagged"],
];

const FLAGS: Record<string, SpecialUse> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\archive": "archive",
  "\\junk": "junk",
  "\\trash": "trash",
  "\\all": "all",
  "\\flagged": "flagged",
};

/**
 * A folder's role from what the server declares (RFC 6154 special-use) or, failing that, from
 * its last path segment. Names are only a fallback: servers name folders in many languages.
 */
export function specialUseOf(
  path: string,
  declared: string | null | undefined,
  delimiter = "/",
): SpecialUse {
  const flag = declared ? FLAGS[declared.toLowerCase()] : undefined;
  if (flag) return flag;
  if (path.toUpperCase() === "INBOX") return "inbox";
  const leaf = path.split(delimiter).pop() ?? path;
  for (const [pattern, use] of NAMES) if (pattern.test(leaf.trim())) return use;
  return "";
}

/** Plain text from HTML, for snippets and search when a message has no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code) % 0x110000))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/** The first words of a message, without quoted replies. */
export function snippetOf(text: string, max = 200): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return lines.length > max ? `${lines.slice(0, max - 1).trimEnd()}…` : lines;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A file name safe to store and to show: no directories, control characters or reserved names,
 * at most 180 characters, keeping the extension.
 */
export function safeFileName(name: string, fallback = "adjunto"): string {
  let clean = (name.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    // Control characters are not allowed in a file name, and would hide its real end.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || RESERVED.test(clean)) clean = fallback;
  if (clean.length > 180) {
    const dot = clean.lastIndexOf(".");
    const extension = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
    clean = clean.slice(0, 180 - extension.length) + extension;
  }
  return clean;
}

const RISKY = new Set([
  "exe",
  "scr",
  "com",
  "bat",
  "cmd",
  "pif",
  "msi",
  "msp",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "hta",
  "cpl",
  "jar",
  "lnk",
  "reg",
  "dll",
  "sys",
  "iso",
  "img",
  "vhd",
  "vhdx",
  "app",
  "dmg",
  "pkg",
  "sh",
  "apk",
]);

/** An executable or a disk image: shown with a warning, never previewed. */
export function riskyAttachment(name: string): boolean {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return RISKY.has(extension) || /\.(pdf|docx?|xlsx?|jpg|png|txt)\s*\.\w+$/i.test(name);
}

export function formatAddress(item: MailAddress): string {
  if (!item.name || item.name === item.address) return item.address;
  return `${item.name} <${item.address}>`;
}

/** Markdown escaping for text taken from a message header. */
function inline(text: string): string {
  return text.replace(/[\\`*_[\]<>|#]/g, (char) => `\\${char}`).replace(/\s+/g, " ");
}

export type ArchiveInput = {
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  date: number;
  account: string;
  messageId: string;
  text: string;
  attachments: { name: string; size: number }[];
  archivedAt: number;
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The note an archived message becomes: its provenance first (who, when, which account, the
 * Message-ID), then the text as it came, inside a fence so nothing in it is read as Markdown.
 */
export function messageMarkdown(input: ArchiveInput): string {
  const title = input.subject.trim() || "(sin asunto)";
  const rows = [
    `| De | ${inline(formatAddress(input.from))} |`,
    `| Para | ${inline(input.to.map(formatAddress).join(", ")) || "—"} |`,
    ...(input.cc.length ? [`| CC | ${inline(input.cc.map(formatAddress).join(", "))} |`] : []),
    `| Fecha | ${isoDate(input.date)} |`,
    `| Cuenta | ${inline(input.account)} |`,
    `| Message-ID | ${inline(input.messageId) || "—"} |`,
    `| Archivado | ${isoDate(input.archivedAt)} |`,
  ];
  const longest = Math.max(
    3,
    ...[...input.text.matchAll(/`+/g)].map((match) => match[0].length + 1),
  );
  const fence = "`".repeat(longest);
  const attachments = input.attachments.length
    ? `\n\n## Adjuntos\n\n${input.attachments.map((item) => `- ${inline(item.name)} (${size(item.size)})`).join("\n")}`
    : "";
  return `# ${inline(title)}\n\n| Campo | Valor |\n| --- | --- |\n${rows.join("\n")}\n\n## Mensaje\n\n${fence}text\n${input.text.trim()}\n${fence}${attachments}\n`;
}

/** Plain text archive: the same provenance as a header block. */
export function messagePlainText(input: ArchiveInput): string {
  const head = [
    `Asunto: ${input.subject.trim() || "(sin asunto)"}`,
    `De: ${formatAddress(input.from)}`,
    `Para: ${input.to.map(formatAddress).join(", ")}`,
    ...(input.cc.length ? [`CC: ${input.cc.map(formatAddress).join(", ")}`] : []),
    `Fecha: ${isoDate(input.date)}`,
    `Cuenta: ${input.account}`,
    `Message-ID: ${input.messageId}`,
    `Archivado: ${isoDate(input.archivedAt)}`,
    ...(input.attachments.length
      ? [`Adjuntos: ${input.attachments.map((item) => item.name).join(", ")}`]
      : []),
  ];
  return `${head.join("\n")}\n\n${input.text.trim()}\n`;
}

/** Keyset cursor of the message list: received_at and id of the last row shown. */
export function encodeCursor(receivedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([receivedAt, id])).toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      typeof value[1] === "string" &&
      value[1].length <= 80
    )
      return { at: value[0], id: value[1] };
  } catch {
    /* a malformed cursor starts from the top */
  }
  return null;
}

/**
 * What a folder sync must do given what was confirmed before and what the server says now. A
 * changed UIDVALIDITY makes every stored UID meaningless: the folder is fetched again (messages
 * whose location disappears are hidden, never archived documents).
 */
export function folderPlan(input: {
  storedValidity: number | null;
  serverValidity: number;
  lastUid: number;
  backfillDone: boolean;
}): { reset: boolean; fromUid: number; backfill: boolean } {
  if (input.storedValidity !== null && input.storedValidity !== input.serverValidity)
    return { reset: true, fromUid: 1, backfill: true };
  return {
    reset: false,
    fromUid: input.lastUid + 1,
    backfill: !input.backfillDone,
  };
}

/** UIDs stored locally that the server no longer has. */
export function vanished(local: readonly number[], remote: readonly number[]): number[] {
  const present = new Set(remote);
  return local.filter((uid) => !present.has(uid));
}

/** Split a list into batches. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}
