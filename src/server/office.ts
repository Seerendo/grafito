import { editorOrigin, isSameOrigin, officeProblem } from "./office-reach.ts";
import type { Sql } from "@/lib/db";
import { readToken, signToken } from "./file-links";

/**
 * Optional Collabora integration over /wopi/files/:id. COLLABORA_URL is the browser URL or
 * same-origin gateway; COLLABORA_INTERNAL_URL is for discovery; GRAFITO_WOPI_URL is Collabora's
 * route back to Grafito. Empty COLLABORA_URL disables editing.
 */

export type OfficeToken = {
  /** Document, owner and editor identity/display name. */
  d: string;
  o: string;
  u: string;
  n: string;
  /** Whether saving is allowed. */
  w: boolean;
  /** Browser origin for editor/application messaging. */
  p: string;
  /** Share authorizing edits to another user's document. */
  s?: string;
};

/** Editor session lifetime. */
const SESSION_SECONDS = 10 * 60 * 60;

const EXTENSIONS = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)$/i;

export function isOfficeName(name: string): boolean {
  return EXTENSIONS.test(name);
}

function env(name: string): string | null {
  const value = process.env[name]?.trim().replace(/\/$/, "");
  return value || null;
}

export function officeEnabled(): boolean {
  return Boolean(env("COLLABORA_URL"));
}

/** Editor origin used for CSP frame-src/form-action and editor URLs; see office-reach.ts. */
export function officeOrigin(pageOrigin?: string | null): string | null {
  const url = env("COLLABORA_URL");
  if (!url || isSameOrigin(url)) return null;
  try {
    return editorOrigin(url, pageOrigin);
  } catch {
    return null;
  }
}

/** Editor reachability problem and corrective setting, or null. */
export function officeReachProblem(pageOrigin: string): string | null {
  const url = env("COLLABORA_URL");
  if (!url) return null;
  try {
    return officeProblem({
      collaboraUrl: url,
      pageOrigin,
      frameAncestors: process.env.GRAFITO_PUBLIC_ORIGIN?.trim() || "localhost:*",
      sslTermination: process.env.COLLABORA_SSL_TERMINATION?.trim().toLowerCase() === "true",
    });
  } catch {
    return null;
  }
}

type Discovery = { actions: Map<string, { edit?: string; view?: string }>; at: number };
let discovery: Discovery | null = null;

/** Supported Collabora formats and URLs from discovery, cached one hour. */
async function readDiscovery(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 60 * 60_000) return discovery;
  const configured = env("COLLABORA_URL");
  const base =
    env("COLLABORA_INTERNAL_URL") ?? (configured && !isSameOrigin(configured) ? configured : null);
  if (!base) throw new Error("El editor de Office no está configurado.");
  const response = await fetch(`${base}/hosting/discovery`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`El editor de Office respondió ${response.status}.`);
  const xml = await response.text();
  const actions = new Map<string, { edit?: string; view?: string }>();
  for (const match of xml.matchAll(/<action\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? "";
    const name = /\bname="([^"]+)"/.exec(attrs)?.[1];
    const ext = /\bext="([^"]+)"/.exec(attrs)?.[1]?.toLowerCase();
    const urlsrc = /\burlsrc="([^"]+)"/.exec(attrs)?.[1]?.replace(/&amp;/g, "&");
    if (!ext || !urlsrc || (name !== "edit" && name !== "view")) continue;
    const entry = actions.get(ext) ?? {};
    entry[name] = urlsrc;
    actions.set(ext, entry);
  }
  discovery = { actions, at: Date.now() };
  return discovery;
}

/** Public editor URL with WOPISrc for the file. */
export async function editorUrl(
  docId: string,
  fileName: string,
  canWrite: boolean,
  lang: string,
  pageOrigin?: string,
): Promise<string> {
  const ext = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
  const entry = (await readDiscovery()).actions.get(ext);
  const urlsrc = (canWrite ? (entry?.edit ?? entry?.view) : (entry?.view ?? entry?.edit)) ?? null;
  if (!urlsrc) throw new Error("El editor de Office no abre ese tipo de archivo.");
  const configured = env("COLLABORA_URL")!;
  const prefix = isSameOrigin(configured) ? "" : new URL(configured).pathname.replace(/\/+$/, "");
  const source = new URL(urlsrc);
  const target = new URL(`${editorOrigin(configured, pageOrigin)}${prefix}${source.pathname}`);
  const wopiBase = env("GRAFITO_WOPI_URL") ?? env("BETTER_AUTH_URL") ?? "http://app:8080";
  target.searchParams.set("WOPISrc", `${wopiBase}/wopi/files/${encodeURIComponent(docId)}`);
  target.searchParams.set("lang", lang);
  // Force light editor mode to keep printed-document text readable under any Grafito theme. SavedUIState=false overrides remembered dark-mode preferences.
  target.searchParams.set("ui_defaults", "UITheme=light;SavedUIState=false");
  return target.toString();
}

export function issueOfficeToken(data: OfficeToken): { token: string; expiresAt: number } {
  return signToken(data, SESSION_SECONDS);
}

/** Validate a WOPI request token for this document. */
export function readOfficeToken(request: Request, docId: string): OfficeToken | null {
  const token = new URL(request.url).searchParams.get("access_token");
  const data = token ? readToken<OfficeToken>(token) : null;
  return data && data.d === docId ? data : null;
}

/** User display name for editor presence and version authors. */
export async function displayNameOf(sql: Sql, userId: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from "user" where id = ${userId} limit 1`;
  return rows[0]?.name?.trim() || "Alguien";
}
