import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Enlaces firmados a archivos (solo servidor). Quien pide el enlace ya pasó
 * los permisos; el enlace lleva el dueño, si permite descargar y su caducidad,
 * firmados con HMAC. Así una `<img>` o un `<iframe>` pueden cargar el archivo
 * aunque el navegador no tenga la cookie de sesión (http fuera de localhost).
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

function signature(docId: string, ownerId: string, expires: number, download: boolean): string {
  return createHmac("sha256", secret()).update(`${docId}.${ownerId}.${expires}.${download ? 1 : 0}`).digest("base64url");
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
  const expected = Buffer.from(signature(docId, ownerId, expires, download));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { ownerId, download };
}
