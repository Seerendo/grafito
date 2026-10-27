import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import { redisDropNote, redisPutNote, redisTakeNote } from "./redis.ts";

/**
 * Notas secretas de un solo uso, como un «privnote» propio (solo servidor):
 * lo que lleva el correo de acceso de un usuario nuevo.
 *
 * - El enlace lleva un token aleatorio de 256 bits, en el fragmento (`#`) de la
 *   URL, que el navegador no manda en la petición ni queda en los registros.
 * - El texto se cifra (AES-256-GCM) con una clave derivada de ese token; lo
 *   guardado se busca por un hash del token. Ni la base, ni Redis, ni un
 *   respaldo pueden leerla sin el enlace.
 * - Se guarda en Redis con caducidad, o en `app_secret_note` si no hay Redis.
 * - Leerla la borra en el mismo paso (`GETDEL` o `delete … returning`).
 */

export type SecretNote = { token: string; id: string };

function idOf(token: string): string {
  return createHash("sha256").update(`grafito-note-id:${token}`).digest("hex");
}

function keyOf(token: string): Buffer {
  return createHash("sha256").update(`grafito-note-key:${token}`).digest();
}

function seal(token: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(token), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

function unseal(token: string, sealed: string): string | null {
  const [iv, tag, data] = sealed.split(".");
  if (!iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyOf(token), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Un token con forma válida (lo que va tras el `#` del enlace). */
export function validNoteToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function createNote(sql: Sql, plain: string, expiresAt: number): Promise<SecretNote> {
  const token = randomBytes(32).toString("base64url");
  const id = idOf(token);
  const sealed = seal(token, plain);
  const seconds = (expiresAt - Date.now()) / 1000;
  const inRedis = await redisPutNote(id, sealed, seconds).catch(() => false);
  if (!inRedis) {
    await sql`insert into app_secret_note (id, sealed, expires_at) values (${id}, ${sealed}, ${expiresAt})`;
  }
  return { token, id };
}

/** Lee la nota y la destruye. `null` si no existe, ya se leyó o venció. */
export async function takeNote(sql: Sql, token: string): Promise<string | null> {
  if (!validNoteToken(token)) return null;
  const id = idOf(token);
  const fromRedis = await redisTakeNote(id).catch(() => null);
  let sealed = fromRedis?.sealed ?? null;
  // La de la base se borra siempre, también si estaba en Redis por error.
  const rows = await sql<{ sealed: string; expires_at: unknown }>`
    delete from app_secret_note where id = ${id} returning sealed, expires_at
  `;
  if (!sealed && rows[0] && Number(rows[0].expires_at) > Date.now()) sealed = rows[0].sealed;
  return sealed ? unseal(token, sealed) : null;
}

/** Anula una nota sin leerla (al reenviar el acceso). */
export async function dropNote(sql: Sql, id: string): Promise<void> {
  await redisDropNote(id).catch(() => undefined);
  await sql`delete from app_secret_note where id = ${id}`;
}

/** Borra las notas vencidas de la base (las de Redis caducan solas). */
export async function purgeNotes(sql: Sql): Promise<void> {
  await sql`delete from app_secret_note where expires_at < ${Date.now()}`;
}
