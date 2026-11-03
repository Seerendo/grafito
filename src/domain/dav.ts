/**
 * WebDAV de la bóveda: rutas, nombres y permisos. Sin base de datos.
 * El árbol real lo arma `server/dav/handle.ts`.
 *
 * `/dav/Personal` es la bóveda de quien entra. `/dav/Compartidos` es lo que
 * le compartieron (y, dentro, las carpetas de un espacio que le concedieron).
 * Un administrador no ve desde aquí las bóvedas ajenas.
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

/** `null`: la bóveda propia. Si no, lo compartido ya resuelto (ver / escribir ese nodo). */
export type DavShareGate = { read: boolean; write: boolean } | null;

/**
 * El rol manda en la bóveda propia. En lo compartido, además, hace falta
 * poder leer o escribir ese nodo: ser administrador no salta esa valla.
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

/** Si un nombre aparece en un listado. Las carpetas se ven para poder llegar a lo demás. */
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

/** Un segmento ya decodificado, o `null` si es `.`, `..`, vacío o trae una barra. */
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

/** Nombre usable en un segmento: sin barras, sin controles, sin punto final. */
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
 * Nombres únicos dentro de una carpeta. Si dos coinciden (sin distinguir
 * mayúsculas), los dos llevan el inicio del id: el nombre pelado deja de usarse.
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

/** El id cuyo segmento coincide. Si hay varios iguales, no elige. */
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
 * `Depth` ausente se lee como 1 (un cliente que no lo manda igual ve los hijos).
 * `infinity` no se recorre: el servidor responde 403 y el cliente puede pedir 1.
 */
export function davDepth(header: string | null): { depth: 0 | 1 } | { reject: true } {
  const value = (header ?? "1").trim().toLowerCase();
  if (value === "0") return { depth: 0 };
  if (value === "1") return { depth: 1 };
  return { reject: true };
}

/** `Overwrite: F` no pisa. Cualquier otra cosa (o ninguna) sí. */
export function overwriteAllowed(header: string | null): boolean {
  return (header ?? "T").trim().toUpperCase() !== "F";
}

/** La ruta de un `Destination` absoluto o relativo. */
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

/** Cuerpo `207 Multi-Status` de un PROPFIND. */
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

/** PROPPATCH no guarda nada: responde 200 para que el cliente siga. */
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

/** Segundos de un `Timeout: Second-N`, entre 1 y 3600. */
export function lockSeconds(header: string | null): number {
  const match = /Second-(\d+)/i.exec(header ?? "");
  const value = match ? Number(match[1]) : 600;
  if (!Number.isFinite(value) || value < 1) return 600;
  return Math.min(Math.floor(value), 3600);
}

/** El token que el cliente presenta en `If` o `Lock-Token`. */
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

/** Intentos fallidos de entrada por WebDAV: 20 en 10 minutos cierran la puerta. */
export const DAV_FAIL_WINDOW_MS = 10 * 60 * 1000;
export const DAV_FAIL_MAX = 20;

export function davLockedOut(stamps: readonly number[], now: number): boolean {
  return (
    stamps.filter((stamp) => now - stamp < DAV_FAIL_WINDOW_MS && now - stamp >= 0).length >=
    DAV_FAIL_MAX
  );
}
