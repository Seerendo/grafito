import type { Sql } from "@/lib/db";

/**
 * Historial de versiones de las notas (solo servidor). Ver
 * `migrations/0010_history_trash_edit.sql`.
 *
 * Se guarda el estado de la nota tras cada cambio de título o texto, venga del
 * navegador del dueño, de alguien con quien la compartió, de la API o de la IA.
 * Los cambios seguidos de la misma persona dentro de `GROUP_MS` se agrupan en
 * una sola versión, para que el autoguardado no llene el historial.
 */

const GROUP_MS = 10 * 60_000;

/** Versiones que se conservan por nota (las más antiguas se descartan). */
const KEEP = 200;

export type VersionSummary = { id: string; title: string; author: string; createdAt: number; size: number };

export async function recordVersion(
  sql: Sql,
  userId: string,
  doc: { id: string; title: string; content: string; author: string; at: number; separate?: boolean },
): Promise<void> {
  const last = await sql<{ id: string; title: string; content: string; author: string; created_at: unknown }>`
    select id, title, content, author, created_at from vault_doc_version
    where user_id = ${userId} and doc_id = ${doc.id}
    order by created_at desc limit 1
  `;
  const previous = last[0];
  if (previous && previous.title === doc.title && previous.content === doc.content) return;
  // Una restauración siempre es una versión aparte, para poder deshacerla.
  if (!doc.separate && previous && previous.author === doc.author && doc.at - Number(previous.created_at) < GROUP_MS) {
    await sql`
      update vault_doc_version set title = ${doc.title}, content = ${doc.content}, created_at = ${doc.at}
      where id = ${previous.id}
    `;
    return;
  }
  await sql`
    insert into vault_doc_version (id, user_id, doc_id, title, content, author, created_at)
    values (${crypto.randomUUID()}, ${userId}, ${doc.id}, ${doc.title}, ${doc.content}, ${doc.author}, ${doc.at})
  `;
  await sql`
    delete from vault_doc_version
    where user_id = ${userId} and doc_id = ${doc.id} and id in (
      select id from vault_doc_version where user_id = ${userId} and doc_id = ${doc.id}
      order by created_at desc offset ${KEEP}
    )
  `;
}

export async function listVersions(sql: Sql, userId: string, docId: string): Promise<VersionSummary[]> {
  const rows = await sql<{ id: string; title: string; author: string; created_at: unknown; size: unknown }>`
    select id, title, author, created_at, length(content) as size from vault_doc_version
    where user_id = ${userId} and doc_id = ${docId}
    order by created_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    createdAt: Number(row.created_at),
    size: Number(row.size),
  }));
}

export async function readVersion(
  sql: Sql,
  userId: string,
  docId: string,
  versionId: string,
): Promise<{ title: string; content: string } | null> {
  const rows = await sql<{ title: string; content: string }>`
    select title, content from vault_doc_version
    where user_id = ${userId} and doc_id = ${docId} and id = ${versionId} limit 1
  `;
  return rows[0] ?? null;
}
