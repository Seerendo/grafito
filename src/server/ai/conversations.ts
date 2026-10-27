import type { Sql } from "@/lib/db";

/**
 * Historial del chat de IA (solo servidor). Ver
 * `migrations/0015_ai_conversations.sql`. Cada conversación guarda sus turnos
 * tal como los muestra el chat; el contexto que se manda al modelo lo recorta
 * el propio chat.
 */

/** Conversaciones que se conservan por usuario (las más antiguas se descartan). */
const KEEP = 200;

export type ConversationSummary = { id: string; title: string; updatedAt: number };

export async function listConversations(sql: Sql, userId: string): Promise<ConversationSummary[]> {
  const rows = await sql<{ id: string; title: string; updated_at: unknown }>`
    select id, title, updated_at from ai_conversation where user_id = ${userId} order by updated_at desc
  `;
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: Number(row.updated_at) }));
}

export async function readConversation(sql: Sql, userId: string, id: string): Promise<{ title: string; turns: unknown[] } | null> {
  const rows = await sql<{ title: string; turns: string }>`
    select title, turns from ai_conversation where user_id = ${userId} and id = ${id} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  try {
    const turns = JSON.parse(row.turns) as unknown;
    return { title: row.title, turns: Array.isArray(turns) ? turns : [] };
  } catch {
    return { title: row.title, turns: [] };
  }
}

export async function writeConversation(
  sql: Sql,
  userId: string,
  input: { id: string; title: string; turns: unknown[] },
): Promise<number> {
  const now = Date.now();
  const turns = JSON.stringify(input.turns);
  await sql`
    insert into ai_conversation (id, user_id, title, turns, created_at, updated_at)
    values (${input.id}, ${userId}, ${input.title}, ${turns}, ${now}, ${now})
    on conflict (id) do update set title = excluded.title, turns = excluded.turns, updated_at = excluded.updated_at
    where ai_conversation.user_id = ${userId}
  `;
  const old = await sql<{ id: string }>`
    select id from ai_conversation where user_id = ${userId} order by updated_at desc offset ${KEEP}
  `;
  for (const row of old) await sql`delete from ai_conversation where id = ${row.id}`;
  return now;
}

export async function deleteConversation(sql: Sql, userId: string, id: string): Promise<void> {
  await sql`delete from ai_conversation where user_id = ${userId} and id = ${id}`;
}
