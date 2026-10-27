import type { Sql } from "@/lib/db";
import { readToken, signToken } from "./file-links";

/**
 * Editor de Office (solo servidor): Collabora Online habla con Grafito por
 * WOPI (`/wopi/files/:id`). Es un servicio aparte y opcional (perfil `office`
 * de docker-compose): Grafito no incluye su código, solo le pasa el archivo y
 * recibe lo guardado. Sin `COLLABORA_URL` la función está apagada.
 *
 *  - `COLLABORA_URL`: dirección de Collabora para el navegador (el iframe).
 *  - `COLLABORA_INTERNAL_URL`: para el servidor de Grafito (discovery).
 *  - `GRAFITO_WOPI_URL`: cómo llega Collabora a Grafito.
 */

export type OfficeToken = {
  /** Documento, dueño, quien edita y su nombre. */
  d: string;
  o: string;
  u: string;
  n: string;
  /** Puede guardar. */
  w: boolean;
  /** Origen del navegador, para los mensajes entre el editor y Grafito. */
  p: string;
  /** Elemento compartido por el que se edita (si no es del propio usuario). */
  s?: string;
};

/** Duración de una sesión del editor. */
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

/** Origen del editor, para la CSP (`frame-src`, `form-action`). */
export function officeOrigin(): string | null {
  const url = env("COLLABORA_URL");
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type Discovery = { actions: Map<string, { edit?: string; view?: string }>; at: number };
let discovery: Discovery | null = null;

/** Qué abre Collabora y con qué URL (`/hosting/discovery`), una hora en caché. */
async function readDiscovery(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 60 * 60_000) return discovery;
  const base = env("COLLABORA_INTERNAL_URL") ?? env("COLLABORA_URL");
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

/** La URL del editor para un archivo, con la dirección pública de Collabora y el WOPISrc. */
export async function editorUrl(docId: string, fileName: string, canWrite: boolean, lang: string): Promise<string> {
  const ext = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
  const entry = (await readDiscovery()).actions.get(ext);
  const urlsrc = (canWrite ? (entry?.edit ?? entry?.view) : (entry?.view ?? entry?.edit)) ?? null;
  if (!urlsrc) throw new Error("El editor de Office no abre ese tipo de archivo.");
  const pub = env("COLLABORA_URL")!;
  const source = new URL(urlsrc);
  const target = new URL(`${pub}${source.pathname}`);
  const wopiBase = env("GRAFITO_WOPI_URL") ?? env("BETTER_AUTH_URL") ?? "http://app:8080";
  target.searchParams.set("WOPISrc", `${wopiBase}/wopi/files/${encodeURIComponent(docId)}`);
  target.searchParams.set("lang", lang);
  // Sin preferencia explícita, Collabora sigue el modo oscuro del sistema y,
  // con un tema oscuro, deja el texto oscuro sobre la página oscura. El editor
  // se abre siempre en claro, como un documento impreso; quien quiera puede
  // cambiarlo desde el propio editor (Ver → Modo oscuro).
  target.searchParams.set("ui_defaults", "UITheme=light");
  return target.toString();
}

export function issueOfficeToken(data: OfficeToken): { token: string; expiresAt: number } {
  return signToken(data, SESSION_SECONDS);
}

/** La ficha de una petición WOPI, si es válida y para ese documento. */
export function readOfficeToken(request: Request, docId: string): OfficeToken | null {
  const token = new URL(request.url).searchParams.get("access_token");
  const data = token ? readToken<OfficeToken>(token) : null;
  return data && data.d === docId ? data : null;
}

/** Nombre visible de un usuario (para el editor y los autores de versiones). */
export async function displayNameOf(sql: Sql, userId: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from "user" where id = ${userId} limit 1`;
  return rows[0]?.name?.trim() || "Alguien";
}
