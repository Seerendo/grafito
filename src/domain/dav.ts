/**
 * Pure WebDAV paths, names and permissions. server/dav/handle.ts builds the tree. /dav/Personal
 * exposes the caller's vault; /dav/Compartidos exposes granted shared/workspace content.
 * Administrators do not gain access to other vaults.
 */
import { PERMISSION } from "./permissions.ts";

export const DAV_PERSONAL = "Personal";
export const DAV_SHARES = "Compartidos";

export type DavWhere =
  | { kind: "root" }
  | { kind: "personal"; segments: string[] }
  | { kind: "shares"; segments: string[] }
  | { kind: "bad" };

export type DavOp =
  | "list"
  | "read-note"
  | "read-file"
  | "create-note"
  | "edit-note"
  | "upload-file"
  | "delete-note"
  | "delete-file"
  | "manage";

const ROLE: Record<Exclude<DavOp, "list">, string> = {
  "read-note": PERMISSION.notesRead,
  "read-file": PERMISSION.filesDownload,
  "create-note": PERMISSION.notesCreate,
  "edit-note": PERMISSION.notesEdit,
  "upload-file": PERMISSION.filesUpload,
  "delete-note": PERMISSION.notesDelete,
  "delete-file": PERMISSION.filesDelete,
  manage: PERMISSION.portfoliosManage,
};

const WRITE_OPS = new Set<DavOp>([
  "create-note",
  "edit-note",
  "upload-file",
  "delete-note",
  "delete-file",
  "manage",
]);

export type DavProfile = { isAdmin: boolean; permissions: readonly string[] };

/** null denotes the owned vault; otherwise this is resolved shared-node read/write access. */
export type DavShareGate = { read: boolean; write: boolean } | null;

/**
 * Role permissions govern owned content. Shared content also requires node access, which
 * administrator status cannot bypass.
 */
export function davPermitted(op: DavOp, profile: DavProfile, share: DavShareGate): boolean {
  if (share) {
    if (WRITE_OPS.has(op) && !share.write) return false;
    if (!WRITE_OPS.has(op) && !share.read) return false;
  }
  if (profile.isAdmin) return true;
  if (op === "list") {
    return (
      profile.permissions.includes(PERMISSION.notesRead) ||
      profile.permissions.includes(PERMISSION.filesDownload) ||
      profile.permissions.includes(PERMISSION.portfoliosManage)
    );
  }
  return profile.permissions.includes(ROLE[op]);
}

/** Whether a name appears in listings. Folders remain visible for navigation. */
export function davShows(profile: DavProfile, kind: "portfolio" | "markdown" | "file"): boolean {
  if (profile.isAdmin) return true;
  if (kind === "markdown") return profile.permissions.includes(PERMISSION.notesRead);
  if (kind === "file") return profile.permissions.includes(PERMISSION.filesDownload);
  return (
    profile.permissions.includes(PERMISSION.portfoliosManage) ||
    profile.permissions.includes(PERMISSION.notesRead) ||
    profile.permissions.includes(PERMISSION.filesDownload)
  );
}

/** Decode one path segment; reject empty, dot, dot-dot and slash-containing values. */
export function cleanSegment(raw: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if ([...value].some((ch) => ch.charCodeAt(0) < 32 || ch === "/" || ch === "\\")) return null;
  value = value.trim();
  if (!value || value === "." || value === "..") return null;
  return value;
}

export function parseDavPath(pathname: string): DavWhere {
  if (!pathname.startsWith("/dav")) return { kind: "bad" };
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  if (trimmed === "/dav") return { kind: "root" };
  if (!trimmed.startsWith("/dav/")) return { kind: "bad" };
  const segments: string[] = [];
  for (const part of trimmed.slice("/dav/".length).split("/")) {
    const clean = cleanSegment(part);
    if (!clean) return { kind: "bad" };
    segments.push(clean);
  }
  const [head, ...tail] = segments;
  if (head === DAV_PERSONAL) return { kind: "personal", segments: tail };
  if (head === DAV_SHARES) return { kind: "shares", segments: tail };
  return { kind: "bad" };
}

/** Safe path segment without slashes, control characters or trailing periods. */
export function sanitizeBase(name: string): string {
  const chars: string[] = [];
  for (const ch of name.trim()) {
    const code = ch.charCodeAt(0);
    chars.push(code < 32 || ch === "/" || ch === "\\" ? " " : ch);
  }
  let value = chars.join("").replace(/\s+/g, " ").trim();
  while (value.endsWith(".") || value.endsWith(" ")) value = value.slice(0, -1);
  return value.slice(0, 120);
}

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

export function noteTitleFromName(name: string): string {
  const clean = sanitizeBase(name) || "nota";
  return clean.replace(/\.(md|markdown)$/i, "").trim() || "nota";
}

export function noteFileName(title: string): string {
  const clean = sanitizeBase(title) || "nota";
  return isMarkdownName(clean) ? clean : `${clean}.md`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot);
}

/**
 * Case-insensitive duplicate names receive ID prefixes on both entries; the ambiguous bare name
 * is no longer used.
 */
export function assignSegments(
  items: readonly { id: string; base: string }[],
): { id: string; segment: string }[] {
  const draft = items.map((item) => ({
    id: item.id,
    base: sanitizeBase(item.base) || item.id.slice(0, 8),
  }));
  const counts = new Map<string, number>();
  for (const item of draft) {
    const key = item.base.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return draft.map((item) => {
    if ((counts.get(item.base.toLowerCase()) ?? 0) < 2) return { id: item.id, segment: item.base };
    const ext = extensionOf(item.base);
    const stem = ext ? item.base.slice(0, -ext.length) : item.base;
    return { id: item.id, segment: `${stem} (${item.id.slice(0, 6)})${ext}` };
  });
}

/** Find the ID matching a segment; refuse ambiguous matches. */
export function matchSegment(
  items: readonly { id: string; segment: string }[],
  wanted: string,
): string | null {
  const exact = items.filter((item) => item.segment === wanted);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;
  const folded = items.filter((item) => item.segment.toLowerCase() === wanted.toLowerCase());
  return folded.length === 1 ? folded[0]!.id : null;
}

/**
 * Missing Depth defaults to one so children remain visible. Reject infinity with 403 rather
 * than recursively enumerating everything.
 */
export function davDepth(header: string | null): { depth: 0 | 1 } | { reject: true } {
  const value = (header ?? "1").trim().toLowerCase();
  if (value === "0") return { depth: 0 };
  if (value === "1") return { depth: 1 };
  return { reject: true };
}

/** Overwrite: F prevents replacement; all other or missing values allow it. */
export function overwriteAllowed(header: string | null): boolean {
  return (header ?? "T").trim().toUpperCase() !== "F";
}

/** Extract the path from an absolute or relative Destination. */
export function pathFromDestination(value: string | null, requestUrl: string): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value, requestUrl).pathname;
  } catch {
    return null;
  }
}

export function davHref(parts: readonly string[], collection: boolean): string {
  const path =
    parts.length === 0 ? "/dav" : `/dav/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
  return collection ? `${path}/` : path;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type DavListed = {
  href: string;
  name: string;
  collection: boolean;
  bytes: number | null;
  mime: string;
  modifiedMs: number;
};

function rfc1123(ms: number): string {
  return new Date(ms).toUTCString();
}

/** PROPFIND 207 Multi-Status body. */
export function propfindXml(items: readonly DavListed[]): string {
  const rows = items
    .map((item) => {
      const kind = item.collection ? "<d:collection/>" : "";
      const length =
        item.bytes === null ? "" : `<d:getcontentlength>${item.bytes}</d:getcontentlength>`;
      const mime = item.mime ? `<d:getcontenttype>${xmlEscape(item.mime)}</d:getcontenttype>` : "";
      const modified =
        item.modifiedMs > 0
          ? `<d:getlastmodified>${rfc1123(item.modifiedMs)}</d:getlastmodified>`
          : "";
      return (
        `<d:response><d:href>${xmlEscape(item.href)}</d:href><d:propstat><d:prop>` +
        `<d:displayname>${xmlEscape(item.name)}</d:displayname>` +
        `<d:resourcetype>${kind}</d:resourcetype>${length}${mime}${modified}` +
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      );
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${rows}</d:multistatus>`;
}

/** PROPPATCH does not persist properties; return success so clients continue. */
export function proppatchXml(href: string, body: string): string {
  const names = [...body.matchAll(/<\/(?:[A-Za-z0-9]+:)?([A-Za-z0-9]+)>/g)]
    .map((match) => match[1] ?? "")
    .filter(
      (name) => name && !["propertyupdate", "set", "remove", "prop"].includes(name.toLowerCase()),
    );
  const unique = [...new Set(names)].slice(0, 40);
  const props = (unique.length > 0 ? unique : ["displayname"])
    .map(
      (name) =>
        `<d:propstat><d:prop><d:${xmlEscape(name)}/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">` +
    `<d:response><d:href>${xmlEscape(href)}</d:href>${props}</d:response></d:multistatus>`
  );
}

/** Timeout seconds from Second-N, bounded to 1–3600. */
export function lockSeconds(header: string | null): number {
  const match = /Second-(\d+)/i.exec(header ?? "");
  const value = match ? Number(match[1]) : 600;
  if (!Number.isFinite(value) || value < 1) return 600;
  return Math.min(Math.floor(value), 3600);
}

/** Lock token supplied through If or Lock-Token. */
export function presentedLock(header: string | null): string | null {
  if (!header) return null;
  const match = /opaquelocktoken:[A-Za-z0-9-]+/i.exec(header);
  return match ? match[0].toLowerCase() : null;
}

export function lockXml(href: string, token: string, seconds: number): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock>` +
    `<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope>` +
    `<d:depth>0</d:depth><d:timeout>Second-${seconds}</d:timeout>` +
    `<d:locktoken><d:href>${xmlEscape(token)}</d:href></d:locktoken>` +
    `<d:owner><d:href>${xmlEscape(href)}</d:href></d:owner>` +
    `</d:activelock></d:lockdiscovery></d:prop>`
  );
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  zip: "application/zip",
};

export function mimeForName(name: string, header: string | null): string {
  const fromHeader = header?.split(";")[0]?.trim() ?? "";
  if (fromHeader && fromHeader.toLowerCase() !== "application/octet-stream")
    return fromHeader.slice(0, 120);
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** Block WebDAV sign-in after twenty failures within ten minutes. */
export const DAV_FAIL_WINDOW_MS = 10 * 60 * 1000;
export const DAV_FAIL_MAX = 20;

export function davLockedOut(stamps: readonly number[], now: number): boolean {
  return (
    stamps.filter((stamp) => now - stamp < DAV_FAIL_WINDOW_MS && now - stamp >= 0).length >=
    DAV_FAIL_MAX
  );
}
