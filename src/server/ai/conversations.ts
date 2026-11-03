import type { Sql } from "@/lib/db";

/**
 * Server chat history stores displayed turns in ai_conversation. memory and memory_until hold
 * compressed older context; see migrations 0015 and 0034.
 */

/** Maximum conversations retained per user; discard the oldest beyond this limit. */
const KEEP = 200;

export type ConversationSummary = { id: string; title: string; updatedAt: number };

export async function listConversations(sql: Sql, userId: string): Promise<ConversationSummary[]> {
  const rows = await sql<{ id: string; title: string; updated_at: unknown }>`
    select id, title, updated_at from ai_conversation where user_id = ${userId} order by updated_at desc
  `;
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: Number(row.updated_at) }));
}

export type StoredMemory = { text: string; untilId: string };

export async function readConversation(
  sql: Sql,
  userId: string,
  id: string,
): Promise<{ title: string; turns: unknown[]; memory: StoredMemory | null } | null> {
  const rows = await sql<{ title: string; turns: string; memory: string; memory_until: string }>`
    select title, turns, memory, memory_until from ai_conversation where user_id = ${userId} and id = ${id} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const memory = row.memory.trim() ? { text: row.memory, untilId: row.memory_until } : null;
  try {
    const turns = JSON.parse(row.turns) as unknown;
    return { title: row.title, turns: Array.isArray(turns) ? turns : [], memory };
  } catch {
    return { title: row.title, turns: [], memory };
  }
}

export async function writeConversation(
  sql: Sql,
  userId: string,
  input: { id: string; title: string; turns: unknown[]; memory: StoredMemory | null },
): Promise<number> {
  const now = Date.now();
  const turns = JSON.stringify(input.turns);
  const memory = input.memory?.text.trim() ?? "";
  const memoryUntil = memory ? (input.memory?.untilId ?? "") : "";
  await sql`
    insert into ai_conversation (id, user_id, title, turns, memory, memory_until, created_at, updated_at)
    values (${input.id}, ${userId}, ${input.title}, ${turns}, ${memory}, ${memoryUntil}, ${now}, ${now})
    on conflict (id) do update set
      title = excluded.title,
      turns = excluded.turns,
      memory = excluded.memory,
      memory_until = excluded.memory_until,
      updated_at = excluded.updated_at
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
