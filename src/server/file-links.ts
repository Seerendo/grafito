import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Enlaces y fichas firmados para archivos (solo servidor). Quien los pide ya
 * pasó los permisos; lo firmado lleva el dueño, qué se permite y la
 * caducidad, con HMAC. Así una `<img>` o un `<iframe>` pueden cargar el
 * archivo aunque el navegador no tenga la cookie de sesión (http fuera de
 * localhost), y el editor de Office (WOPI) puede leerlo y guardarlo.
 */

const TTL_SECONDS = 60 * 60;

let fallback: Buffer | null = null;

function secret(): Buffer {
  const raw = process.env.BETTER_AUTH_SECRET?.trim() || process.env.GRAFITO_ENCRYPTION_KEY?.trim();
  if (raw) return createHash("sha256").update(`grafito-file-links:${raw}`).digest();
  // Sin secreto configurado: uno por proceso (los enlaces caducan al reiniciar).
  fallback ??= randomBytes(32);
  return fallback;
}

function hmac(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signature(docId: string, ownerId: string, expires: number, download: boolean): string {
  return hmac(`${docId}.${ownerId}.${expires}.${download ? 1 : 0}`);
}

export function signedFileUrl(docId: string, ownerId: string, download = false): string {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const params = new URLSearchParams({ o: ownerId, e: String(expires), s: signature(docId, ownerId, expires, download) });
  if (download) params.set("d", "1");
  return `/api/files/${encodeURIComponent(docId)}?${params}`;
}

/** Dueño y permiso de descarga de un enlace firmado válido; null si no lo es. */
export function verifyFileUrl(docId: string, params: URLSearchParams): { ownerId: string; download: boolean } | null {
  const ownerId = params.get("o");
  const expires = Number(params.get("e"));
  const given = params.get("s");
  const download = params.get("d") === "1";
  if (!ownerId || !given || !Number.isFinite(expires) || expires * 1000 < Date.now()) return null;
  return same(signature(docId, ownerId, expires, download), given) ? { ownerId, download } : null;
}

/**
 * Ficha firmada con datos arbitrarios (`<datos>.<firma>`, base64url) y
 * caducidad en segundos. La usa el editor de Office como `access_token`.
 */
export function signToken<T extends object>(data: T, ttlSeconds: number): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const body = Buffer.from(JSON.stringify({ ...data, exp: expiresAt })).toString("base64url");
  return { token: `${body}.${hmac(`token.${body}`)}`, expiresAt };
}

export function readToken<T extends object>(token: string): T | null {
  const [body, given] = token.split(".");
  if (!body || !given || !same(hmac(`token.${body}`), given)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
