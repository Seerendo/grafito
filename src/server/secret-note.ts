import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import { redisDropNote, redisPutNote, redisTakeNote } from "./redis.ts";

/**
 * One-use access-email notes use a random 256-bit URL-fragment token, excluded from navigation
 * requests and logs. Derive an AES-GCM key from the token and index ciphertext by its hash.
 * Store with Redis expiry or app_secret_note; atomically delete on read via GETDEL or DELETE
 * RETURNING.
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
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}

function unseal(token: string, sealed: string): string | null {
  const [iv, tag, data] = sealed.split(".");
  if (!iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyOf(token), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Validate the URL-fragment token shape. */
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

/** Read and destroy a note; null when absent, consumed or expired. */
export async function takeNote(sql: Sql, token: string): Promise<string | null> {
  if (!validNoteToken(token)) return null;
  const id = idOf(token);
  const fromRedis = await redisTakeNote(id).catch(() => null);
  let sealed = fromRedis?.sealed ?? null;
  // Always delete a database copy even if the note also existed in Redis.
  const rows = await sql<{ sealed: string; expires_at: unknown }>`
    delete from app_secret_note where id = ${id} returning sealed, expires_at
  `;
  if (!sealed && rows[0] && Number(rows[0].expires_at) > Date.now()) sealed = rows[0].sealed;
  return sealed ? unseal(token, sealed) : null;
}

/** Revoke an unread note when resending access. */
export async function dropNote(sql: Sql, id: string): Promise<void> {
  await redisDropNote(id).catch(() => undefined);
  await sql`delete from app_secret_note where id = ${id}`;
}

/** Prune expired database notes; Redis expires its own entries. */
export async function purgeNotes(sql: Sql): Promise<void> {
  await sql`delete from app_secret_note where expires_at < ${Date.now()}`;
}
