import type { Sql } from "@/lib/db";
import { deleteBlob } from "./blobs";

/**
 * Record note title/content changes from all clients, shared editors, API and AI. Group
 * same-author changes within GROUP_MS. File versions retain object keys; preserve the original
 * upload and group only autosaves, never explicit saves. See migrations 0010, 0012 and 0014.
 */

const GROUP_MS = 10 * 60_000;

/** Maximum retained versions per note; prune oldest entries. */
const KEEP = 200;

export type VersionSummary = {
  id: string;
  title: string;
  author: string;
  createdAt: number;
  size: number;
  /** File version without comparable text. */
  file: boolean;
};

export async function recordVersion(
  sql: Sql,
  userId: string,
  doc: {
    id: string;
    title: string;
    content: string;
    author: string;
    at: number;
    separate?: boolean;
  },
): Promise<void> {
  const last = await sql<{
    id: string;
    title: string;
    content: string;
    author: string;
    created_at: unknown;
  }>`
    select id, title, content, author, created_at from vault_doc_version
    where user_id = ${userId} and doc_id = ${doc.id}
    order by created_at desc limit 1
  `;
  const previous = last[0];
  if (previous && previous.title === doc.title && previous.content === doc.content) return;
  // Restoration always creates a separate undoable version.
  if (
    !doc.separate &&
    previous &&
    previous.author === doc.author &&
    doc.at - Number(previous.created_at) < GROUP_MS
  ) {
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
  await prune(sql, userId, doc.id);
}

/** Prune versions beyond KEEP and their unreferenced file objects. */
async function prune(sql: Sql, userId: string, docId: string): Promise<void> {
  const old = await sql<{ id: string; file_key: string | null }>`
    select id, file_key from vault_doc_version where user_id = ${userId} and doc_id = ${docId}
    order by created_at desc offset ${KEEP}
  `;
  for (const row of old) {
    await sql`delete from vault_doc_version where id = ${row.id}`;
    if (row.file_key) await deleteBlob(sql, row.file_key);
  }
}

/** Original uploaded file version before its first edit. */
export async function ensureFileBaseline(
  sql: Sql,
  userId: string,
  doc: { id: string; title: string; key: string; size: number; author: string; at: number },
): Promise<void> {
  const rows = await sql<{ id: string }>`
    select id from vault_doc_version where user_id = ${userId} and doc_id = ${doc.id} and file_key is not null limit 1
  `;
  if (rows[0]) return;
  await sql`
    insert into vault_doc_version (id, user_id, doc_id, title, content, author, created_at, file_key, file_size)
    values (${crypto.randomUUID()}, ${userId}, ${doc.id}, ${doc.title}, '', ${doc.author}, ${doc.at}, ${doc.key}, ${doc.size})
  `;
}

/**
 * Replace a recent same-author autosave within GROUP_MS, excluding the original, and remove the
 * now-unused object.
 */
export async function recordFileVersion(
  sql: Sql,
  userId: string,
  doc: {
    id: string;
    title: string;
    key: string;
    size: number;
    author: string;
    at: number;
    separate?: boolean;
    autosave?: boolean;
  },
): Promise<void> {
  const last = await sql<{
    id: string;
    author: string;
    created_at: unknown;
    file_key: string | null;
    autosave: unknown;
  }>`
    select id, author, created_at, file_key, autosave from vault_doc_version
    where user_id = ${userId} and doc_id = ${doc.id}
    order by created_at desc limit 2
  `;
  const previous = last[0];
  const autosave = Boolean(doc.autosave) && !doc.separate;
  const groupable =
    !doc.separate &&
    last.length === 2 &&
    previous?.file_key &&
    (previous.autosave === true || previous.autosave === "t") &&
    previous.author === doc.author &&
    doc.at - Number(previous.created_at) < GROUP_MS;
  if (groupable && previous?.file_key) {
    await sql`
      update vault_doc_version set title = ${doc.title}, file_key = ${doc.key}, file_size = ${doc.size}, created_at = ${doc.at},
        autosave = ${autosave}
      where id = ${previous.id}
    `;
    await deleteBlob(sql, previous.file_key);
    return;
  }
  await sql`
    insert into vault_doc_version (id, user_id, doc_id, title, content, author, created_at, file_key, file_size, autosave)
    values (${crypto.randomUUID()}, ${userId}, ${doc.id}, ${doc.title}, '', ${doc.author}, ${doc.at}, ${doc.key}, ${doc.size}, ${autosave})
  `;
  await prune(sql, userId, doc.id);
}

/** All document-version keys for trash purging. */
export async function versionKeys(sql: Sql, userId: string, docId: string): Promise<string[]> {
  const rows = await sql<{ file_key: string }>`
    select file_key from vault_doc_version where user_id = ${userId} and doc_id = ${docId} and file_key is not null
  `;
  return rows.map((row) => row.file_key);
}

export async function listVersions(
  sql: Sql,
  userId: string,
  docId: string,
): Promise<VersionSummary[]> {
  const rows = await sql<{
    id: string;
    title: string;
    author: string;
    created_at: unknown;
    size: unknown;
    file_key: string | null;
  }>`
    select id, title, author, created_at, coalesce(file_size, length(content)) as size, file_key from vault_doc_version
    where user_id = ${userId} and doc_id = ${docId}
    order by created_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    createdAt: Number(row.created_at),
    size: Number(row.size),
    file: Boolean(row.file_key),
  }));
}

export async function readVersion(
  sql: Sql,
  userId: string,
  docId: string,
  versionId: string,
): Promise<{
  title: string;
  content: string;
  fileKey: string | null;
  fileSize: number | null;
} | null> {
  const rows = await sql<{
    title: string;
    content: string;
    file_key: string | null;
    file_size: unknown;
  }>`
    select title, content, file_key, file_size from vault_doc_version
    where user_id = ${userId} and doc_id = ${docId} and id = ${versionId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    title: row.title,
    content: row.content,
    fileKey: row.file_key,
    fileSize: row.file_size == null ? null : Number(row.file_size),
  };
}
