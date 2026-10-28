import type { Sql } from "@/lib/db";

/**
 * Comentarios de un documento (solo servidor). Ver
 * `migrations/0018_doc_comments.sql` y `comments.functions.ts`, que comprueba
 * quién tiene acceso.
 */

export const MAX_COMMENT = 4000;
/** Comentarios que se conservan por documento (los más antiguos se descartan). */
const KEEP = 500;

export type DocComment = { id: string; authorId: string | null; author: string; body: string; at: number };

export async function listComments(sql: Sql, ownerId: string, docId: string): Promise<DocComment[]> {
  const rows = await sql<{ id: string; author_id: string | null; author_name: string; body: string; created_at: unknown }>`
    select id, author_id, author_name, body, created_at from doc_comment
    where owner_id = ${ownerId} and doc_id = ${docId} order by created_at
  `;
  return rows.map((row) => ({
    id: row.id,
    authorId: row.author_id,
    author: row.author_name,
    body: row.body,
    at: Number(row.created_at),
  }));
}

export async function addComment(
  sql: Sql,
  input: { ownerId: string; docId: string; authorId: string; authorName: string; body: string },
): Promise<void> {
  await sql`
    insert into doc_comment (id, owner_id, doc_id, author_id, author_name, body, created_at)
    values (${crypto.randomUUID()}, ${input.ownerId}, ${input.docId}, ${input.authorId}, ${input.authorName}, ${input.body}, ${Date.now()})
  `;
  const old = await sql<{ id: string }>`
    select id from doc_comment where owner_id = ${input.ownerId} and doc_id = ${input.docId}
    order by created_at desc offset ${KEEP}
  `;
  for (const row of old) await sql`delete from doc_comment where id = ${row.id}`;
}

/** Borra un comentario si lo escribió `userId` o es el dueño del documento. */
export async function deleteComment(sql: Sql, input: { ownerId: string; docId: string; id: string; userId: string }): Promise<void> {
  await sql`
    delete from doc_comment
    where id = ${input.id} and owner_id = ${input.ownerId} and doc_id = ${input.docId}
      and (author_id = ${input.userId} or owner_id = ${input.userId})
  `;
}

export async function purgeComments(sql: Sql, ownerId: string, docId: string): Promise<void> {
  await sql`delete from doc_comment where owner_id = ${ownerId} and doc_id = ${docId}`;
}
