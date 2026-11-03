import type { Sql } from "@/lib/db";
import { isTextAnchor, type TextAnchor } from "@/domain/vault/anchor";

/** Server document comments; migration 0018 defines storage and comments.functions.ts enforces access. */

export const MAX_COMMENT = 4000;
/** Maximum retained comments per document; discard oldest entries. */
const KEEP = 500;

/** An anchor attaches the comment to a PDF phrase. */
export type DocComment = {
  id: string;
  authorId: string | null;
  author: string;
  body: string;
  at: number;
  anchor: TextAnchor | null;
};

function parseAnchor(raw: string | null): TextAnchor | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isTextAnchor(value) ? value : null;
  } catch {
    return null;
  }
}

export async function listComments(
  sql: Sql,
  ownerId: string,
  docId: string,
): Promise<DocComment[]> {
  const rows = await sql<{
    id: string;
    author_id: string | null;
    author_name: string;
    body: string;
    created_at: unknown;
    anchor: string | null;
  }>`
    select id, author_id, author_name, body, created_at, anchor from doc_comment
    where owner_id = ${ownerId} and doc_id = ${docId} order by created_at
  `;
  return rows.map((row) => ({
    id: row.id,
    authorId: row.author_id,
    author: row.author_name,
    body: row.body,
    at: Number(row.created_at),
    anchor: parseAnchor(row.anchor),
  }));
}

export async function addComment(
  sql: Sql,
  input: {
    ownerId: string;
    docId: string;
    authorId: string;
    authorName: string;
    body: string;
    anchor?: TextAnchor | null;
  },
): Promise<void> {
  const anchor = input.anchor ? JSON.stringify(input.anchor) : null;
  await sql`
    insert into doc_comment (id, owner_id, doc_id, author_id, author_name, body, created_at, anchor)
    values (${crypto.randomUUID()}, ${input.ownerId}, ${input.docId}, ${input.authorId}, ${input.authorName}, ${input.body}, ${Date.now()}, ${anchor})
  `;
  const old = await sql<{ id: string }>`
    select id from doc_comment where owner_id = ${input.ownerId} and doc_id = ${input.docId}
    order by created_at desc offset ${KEEP}
  `;
  for (const row of old) await sql`delete from doc_comment where id = ${row.id}`;
}

/** Delete only when userId authored the comment or owns the document. */
export async function deleteComment(
  sql: Sql,
  input: { ownerId: string; docId: string; id: string; userId: string },
): Promise<void> {
  await sql`
    delete from doc_comment
    where id = ${input.id} and owner_id = ${input.ownerId} and doc_id = ${input.docId}
      and (author_id = ${input.userId} or owner_id = ${input.userId})
  `;
}

export async function purgeComments(sql: Sql, ownerId: string, docId: string): Promise<void> {
  await sql`delete from doc_comment where owner_id = ${ownerId} and doc_id = ${docId}`;
}
