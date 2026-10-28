import type { Sql } from "@/lib/db";

/**
 * Perfiles del chat de IA (solo servidor). Ver `migrations/0017_ai_profiles.sql`.
 * Cada persona crea los suyos; el chat manda el id del perfil elegido y el
 * asistente suma sus indicaciones (y, si es de solo lectura, deja fuera las
 * herramientas que crean o editan; ver `agent.ts`).
 */

/** Perfiles por usuario. */
export const MAX_PROFILES = 30;

export type AiProfile = { id: string; name: string; instructions: string; readOnly: boolean };

type Row = { id: string; name: string; instructions: string; read_only: unknown };

const fromRow = (row: Row): AiProfile => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  readOnly: row.read_only === true || row.read_only === "t",
});

export async function listProfiles(sql: Sql, userId: string): Promise<AiProfile[]> {
  const rows = await sql<Row>`
    select id, name, instructions, read_only from ai_profile where user_id = ${userId} order by lower(name)
  `;
  return rows.map(fromRow);
}

export async function readProfile(sql: Sql, userId: string, id: string): Promise<AiProfile | null> {
  const rows = await sql<Row>`
    select id, name, instructions, read_only from ai_profile where user_id = ${userId} and id = ${id} limit 1
  `;
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Crea o actualiza un perfil; `false` si ya tiene el máximo y es uno nuevo. */
export async function writeProfile(sql: Sql, userId: string, profile: AiProfile): Promise<boolean> {
  const exists = await readProfile(sql, userId, profile.id);
  if (!exists) {
    const count = await sql<{ n: unknown }>`select count(*) as n from ai_profile where user_id = ${userId}`;
    if (Number(count[0]?.n ?? 0) >= MAX_PROFILES) return false;
  }
  const now = Date.now();
  await sql`
    insert into ai_profile (id, user_id, name, instructions, read_only, created_at, updated_at)
    values (${profile.id}, ${userId}, ${profile.name}, ${profile.instructions}, ${profile.readOnly}, ${now}, ${now})
    on conflict (id) do update set
      name = excluded.name, instructions = excluded.instructions, read_only = excluded.read_only, updated_at = excluded.updated_at
    where ai_profile.user_id = ${userId}
  `;
  return true;
}

export async function deleteProfile(sql: Sql, userId: string, id: string): Promise<void> {
  await sql`delete from ai_profile where user_id = ${userId} and id = ${id}`;
}
