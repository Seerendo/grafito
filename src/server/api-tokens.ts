import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";

/**
 * Tokens personales de la API REST (solo servidor). Tienen la forma
 * `gft_<43 caracteres>`; en la base solo queda su SHA-256 y un prefijo para
 * reconocerlos en la lista.
 */

export const TOKEN_PREFIX = "gft_";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type TokenRow = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };

export async function listTokens(sql: Sql, userId: string): Promise<TokenRow[]> {
  const rows = await sql<{ id: string; name: string; prefix: string; created_at: unknown; last_used_at: unknown }>`
    select id, name, prefix, created_at, last_used_at from api_token where user_id = ${userId} order by created_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
  }));
}

/** Crea un token y lo devuelve en claro; es la única vez que se puede ver. */
export async function createToken(sql: Sql, userId: string, name: string): Promise<{ token: string; row: TokenRow }> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const prefix = token.slice(0, 10);
  const clean = name.trim().slice(0, 60) || "Token";
  await sql`
    insert into api_token (id, user_id, name, prefix, token_hash)
    values (${id}, ${userId}, ${clean}, ${prefix}, ${hash(token)})
  `;
  return { token, row: { id, name: clean, prefix, createdAt: new Date().toISOString(), lastUsedAt: null } };
}

export async function revokeToken(sql: Sql, userId: string, id: string): Promise<void> {
  await sql`delete from api_token where id = ${id} and user_id = ${userId}`;
}

/** Usuario dueño del token, o `null`. Anota el último uso. */
export async function resolveToken(sql: Sql, token: string): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rows = await sql<{ id: string; user_id: string }>`
    select t.id, t.user_id from api_token t join "user" u on u.id = t.user_id
    where t.token_hash = ${hash(token)} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  await sql`update api_token set last_used_at = now() where id = ${row.id}`;
  return row.user_id;
}
