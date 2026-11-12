import type { Sql } from "@/lib/db";
import { replaceWikiTitle } from "@/domain/vault/links";
import { withManualLink } from "@/domain/vault/manual-link";
import { merge3 } from "@/domain/vault/merge";
import { descendantIds } from "@/domain/vault/portfolios";
import type { Document, ManualLink, Portfolio } from "@/domain/vault/types";
import { migrateLegacyFiles, removeFile, storeIncomingFile } from "./files";
import { ensureFileBaseline, recordFileVersion, recordVersion, versionKeys } from "./history";
import { noteChange } from "./notify";
import { purgeComments } from "./comments";
import { purgeSignatures } from "./signature";

/**
 * Authoritative per-user server vault for browser synchronization, REST API and AI. Each
 * mutation advances the user revision. Tombstones propagate deletions; trash retains content
 * for TRASH_DAYS. See migration 0008.
 */

export const TRASH_DAYS = 30;

/** Note-text limit, approximately four hundred KB. */
export const MAX_CONTENT = 400_000;

type DocRow = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolio_id: string | null;
  content: string;
  file_name: string | null;
  file_mime: string | null;
  file_data: string | null;
  file_key: string | null;
  file_size: unknown;
  links_json: string;
  pinned: unknown;
  created_at: unknown;
  updated_at: unknown;
  created_by: string;
  updated_by: string;
  deleted: unknown;
};

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function parseLinks(raw: string): ManualLink[] {
  try {
    const links = JSON.parse(raw) as ManualLink[];
    return Array.isArray(links)
      ? links.filter((link) => link && typeof link.targetId === "string")
      : [];
  } catch {
    return [];
  }
}

function toDocument(row: DocRow): Document {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    portfolioId: row.portfolio_id,
    content: row.content,
    file: row.file_name
      ? {
          name: row.file_name,
          mime: row.file_mime ?? "application/octet-stream",
          ...(row.file_key ? { key: row.file_key, size: Number(row.file_size ?? 0) } : {}),
          ...(row.file_data ? { dataUrl: row.file_data } : {}),
        }
      : null,
    links: parseLinks(row.links_json),
    pinned: flag(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/** Reserve the user's next revision. */
export async function nextRevision(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<{ revision: number }>`
    insert into vault_state (user_id, revision) values (${userId}, 1)
    on conflict (user_id) do update set revision = vault_state.revision + 1
    returning revision
  `;
  return Number(rows[0]!.revision);
}

export async function currentRevision(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<{
    revision: number;
  }>`select revision from vault_state where user_id = ${userId}`;
  return Number(rows[0]?.revision ?? 0);
}

async function writeDoc(
  sql: Sql,
  userId: string,
  doc: Document,
  rev: number,
  onlyIfNewer: boolean,
  separateVersion = false,
  /** Change actor when different from the owner, such as a shared editor. */
  actorId = userId,
): Promise<void> {
  const before = await sql<{
    title: string;
    content: string;
    deleted: unknown;
    updated_at: unknown;
  }>`
    select title, content, deleted, updated_at from vault_doc where user_id = ${userId} and id = ${doc.id} limit 1
  `;
  const prior = before[0] && !flag(before[0].deleted) ? before[0] : null;
  await upsertDoc(sql, userId, doc, rev, onlyIfNewer);
  if (onlyIfNewer && prior && Number(prior.updated_at) > doc.updatedAt) return;
  if (doc.kind !== "markdown") return;
  if (prior && prior.title === doc.title && prior.content === doc.content) return;
  await recordVersion(sql, userId, {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    author: doc.updatedBy,
    at: doc.updatedAt,
    separate: separateVersion,
  });
  await noteChange(sql, { ownerId: userId, docId: doc.id, actorId, actorName: doc.updatedBy });
}

async function upsertDoc(
  sql: Sql,
  userId: string,
  doc: Document,
  rev: number,
  onlyIfNewer: boolean,
): Promise<void> {
  const file = doc.file;
  const links = JSON.stringify(doc.links ?? []);
  if (onlyIfNewer) {
    // Newest changes win so stale browsers cannot overwrite AI changes.
    await sql`
      insert into vault_doc (user_id, id, title, kind, portfolio_id, content, file_name, file_mime, file_data,
        file_key, file_size, links_json, pinned, created_at, updated_at, created_by, updated_by, rev, deleted)
      values (${userId}, ${doc.id}, ${doc.title}, ${doc.kind}, ${doc.portfolioId}, ${doc.content},
        ${file?.name ?? null}, ${file?.mime ?? null}, ${file?.key ? null : (file?.dataUrl ?? null)},
        ${file?.key ?? null}, ${file?.size ?? null}, ${links}, ${doc.pinned},
        ${doc.createdAt}, ${doc.updatedAt}, ${doc.createdBy}, ${doc.updatedBy}, ${rev}, false)
      on conflict (user_id, id) do update set
        title = excluded.title, kind = excluded.kind, portfolio_id = excluded.portfolio_id,
        content = excluded.content, file_name = excluded.file_name, file_mime = excluded.file_mime,
        file_data = excluded.file_data, file_key = excluded.file_key, file_size = excluded.file_size, links_json = excluded.links_json, pinned = excluded.pinned,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by, rev = excluded.rev, deleted = false,
        deleted_at = null
      where vault_doc.deleted or vault_doc.updated_at <= excluded.updated_at
    `;
    return;
  }
  await sql`
    insert into vault_doc (user_id, id, title, kind, portfolio_id, content, file_name, file_mime, file_data,
      file_key, file_size, links_json, pinned, created_at, updated_at, created_by, updated_by, rev, deleted)
    values (${userId}, ${doc.id}, ${doc.title}, ${doc.kind}, ${doc.portfolioId}, ${doc.content},
      ${file?.name ?? null}, ${file?.mime ?? null}, ${file?.key ? null : (file?.dataUrl ?? null)},
      ${file?.key ?? null}, ${file?.size ?? null}, ${links}, ${doc.pinned},
      ${doc.createdAt}, ${doc.updatedAt}, ${doc.createdBy}, ${doc.updatedBy}, ${rev}, false)
    on conflict (user_id, id) do update set
      title = excluded.title, kind = excluded.kind, portfolio_id = excluded.portfolio_id,
      content = excluded.content, file_name = excluded.file_name, file_mime = excluded.file_mime,
      file_data = excluded.file_data, file_key = excluded.file_key, file_size = excluded.file_size, links_json = excluded.links_json, pinned = excluded.pinned,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, rev = excluded.rev, deleted = false,
      deleted_at = null
  `;
}

// Browser synchronization.

export type VaultChanges = {
  docs: Document[];
  deletedDocs: string[];
  portfolios: Portfolio[];
  deletedPortfolios: string[];
};

export type PushResult = {
  revision: number;
  /** Merged notes that clients must fetch again. */
  merged: string[];
  /** Conflicting notes retain the server version and return it for resolution. */
  conflicts: Document[];
};

/**
 * Apply browser changes. With a base, merge concurrent note edits through merge3 or return
 * conflicts without overwriting. Files and legacy caches without bases use newest-wins.
 */
export async function pushChanges(
  sql: Sql,
  userId: string,
  changes: VaultChanges,
): Promise<PushResult> {
  const empty =
    changes.docs.length +
      changes.deletedDocs.length +
      changes.portfolios.length +
      changes.deletedPortfolios.length ===
    0;
  if (empty) return { revision: await currentRevision(sql, userId), merged: [], conflicts: [] };
  const rev = await nextRevision(sql, userId);
  const now = Date.now();
  for (const portfolio of changes.portfolios) {
    // Update links only when supplied; API and Git callers omit them.
    const links = portfolio.links ? JSON.stringify(portfolio.links) : null;
    await sql`
      insert into vault_portfolio (user_id, id, name, parent_id, rev, deleted, links_json)
      values (${userId}, ${portfolio.id}, ${portfolio.name}, ${portfolio.parentId}, ${rev}, false, ${links ?? "[]"})
      on conflict (user_id, id) do update set
        name = excluded.name, parent_id = excluded.parent_id, rev = excluded.rev, deleted = false, deleted_at = null,
        links_json = coalesce(${links}, vault_portfolio.links_json)
    `;
  }
  for (const id of changes.deletedPortfolios) {
    await sql`
      update vault_portfolio set deleted = true, deleted_at = ${now}, rev = ${rev}
      where user_id = ${userId} and id = ${id} and not deleted
    `;
  }
  const converted: string[] = [];
  const merged: string[] = [];
  const conflicts: Document[] = [];
  for (const { base, ...incoming } of changes.docs) {
    if (incoming.kind === "markdown" && base) {
      const rows = await sql<{
        title: string;
        content: string;
        updated_at: unknown;
        deleted: unknown;
      }>`
        select title, content, updated_at, deleted from vault_doc where user_id = ${userId} and id = ${incoming.id} limit 1
      `;
      const current = rows[0] && !flag(rows[0].deleted) ? rows[0] : null;
      if (current && Number(current.updated_at) !== base.updatedAt) {
        const result = merge3(base.content, incoming.content, current.content);
        if (!result.ok) {
          const theirs = await getDoc(sql, userId, incoming.id);
          if (theirs) conflicts.push(theirs);
          continue;
        }
        const doc: Document = {
          ...incoming,
          content: result.text,
          title: incoming.title !== base.title ? incoming.title : current.title,
          updatedAt: Math.max(Date.now(), Number(current.updated_at) + 1),
        };
        await writeDoc(sql, userId, doc, rev, false);
        merged.push(doc.id);
        continue;
      }
      // An edit based on current server state may write despite an older timestamp, as when explicitly keeping a local conflict version.
      if (current && incoming.updatedAt <= Number(current.updated_at)) {
        await writeDoc(
          sql,
          userId,
          { ...incoming, updatedAt: Number(current.updated_at) + 1 },
          rev,
          false,
        );
        merged.push(incoming.id);
        continue;
      }
    }
    const stored =
      incoming.kind === "file" ? await storeIncomingFile(sql, userId, incoming.file) : null;
    let doc = stored ? { ...incoming, file: stored.file } : incoming;
    // File content changes only server-side; browser renames/moves must not restore an obsolete storage key.
    if (doc.kind === "file" && doc.file) {
      const current = await sql<{ file_key: string | null; file_size: unknown }>`
        select file_key, file_size from vault_doc where user_id = ${userId} and id = ${doc.id} and not deleted limit 1
      `;
      if (current[0]?.file_key) {
        doc = {
          ...doc,
          file: {
            ...doc.file,
            key: current[0].file_key,
            size: Number(current[0].file_size ?? 0),
            dataUrl: undefined,
          },
        };
      }
    }
    if (stored?.converted) converted.push(doc.id);
    await writeDoc(sql, userId, doc, rev, true);
  }
  // Trash retains content until purge or expiry.
  for (const id of changes.deletedDocs) {
    await sql`
      update vault_doc set deleted = true, deleted_at = ${now}, rev = ${rev}
      where user_id = ${userId} and id = ${id} and not deleted
    `;
  }
  if (changes.deletedDocs.length > 0) await purgeExpired(sql, userId);
  if (converted.length === 0) return { revision: rev, merged, conflicts };
  // When inline file bytes move to storage, advance revision again so clients fetch the key and discard cached bytes.
  const after = await nextRevision(sql, userId);
  for (const id of converted)
    await sql`update vault_doc set rev = ${after} where user_id = ${userId} and id = ${id}`;
  return { revision: after, merged, conflicts };
}

/** Changes after since, including deletions. */
export async function pullChanges(
  sql: Sql,
  userId: string,
  since: number,
): Promise<VaultChanges & { revision: number }> {
  await migrateLegacyFiles(sql, userId, () => nextRevision(sql, userId));
  const revision = await currentRevision(sql, userId);
  const docs = await sql<DocRow>`
    select id, title, kind, portfolio_id, content, file_name, file_mime, file_data, file_key, file_size, links_json, pinned,
      created_at, updated_at, created_by, updated_by, deleted
    from vault_doc where user_id = ${userId} and rev > ${since}
  `;
  const portfolios = await sql<{
    id: string;
    name: string;
    parent_id: string | null;
    deleted: unknown;
    links_json: string | null;
  }>`
    select id, name, parent_id, deleted, links_json from vault_portfolio where user_id = ${userId} and rev > ${since}
  `;
  return {
    revision,
    docs: docs.filter((row) => !flag(row.deleted)).map(toDocument),
    deletedDocs: docs.filter((row) => flag(row.deleted)).map((row) => row.id),
    portfolios: portfolios
      .filter((row) => !flag(row.deleted))
      .map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parent_id,
        links: parseLinks(row.links_json ?? "[]"),
      })),
    deletedPortfolios: portfolios.filter((row) => flag(row.deleted)).map((row) => row.id),
  };
}

// Read/write operations for API and AI.

export type DocSummary = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  updatedAt: number;
  fileName: string | null;
  fileMime: string | null;
};

export async function listPortfolios(sql: Sql, userId: string): Promise<Portfolio[]> {
  const rows = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from vault_portfolio where user_id = ${userId} and not deleted order by name
  `;
  return rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id }));
}

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, "")}%`;
}

export async function listDocs(
  sql: Sql,
  userId: string,
  filter: { portfolioId?: string | null; query?: string; limit?: number } = {},
): Promise<DocSummary[]> {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const term = filter.query?.trim() ? likeTerm(filter.query.trim()) : null;
  const byPortfolio = filter.portfolioId !== undefined;
  const rows = await sql<{
    id: string;
    title: string;
    kind: "markdown" | "file";
    portfolio_id: string | null;
    updated_at: unknown;
    file_name: string | null;
    file_mime: string | null;
  }>`
    select id, title, kind, portfolio_id, updated_at, file_name, file_mime
    from vault_doc
    where user_id = ${userId} and not deleted
      and (${!byPortfolio} or coalesce(portfolio_id, '') = coalesce(${filter.portfolioId ?? null}, ''))
      and (${term === null} or title ilike ${term ?? ""} or content ilike ${term ?? ""}
        or exists (
          select 1 from data_meta m
          where m.owner_id = vault_doc.user_id and m.doc_id = vault_doc.id and m.search_text ilike ${term ?? ""}
        ))
    order by updated_at desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    portfolioId: row.portfolio_id,
    updatedAt: Number(row.updated_at),
    fileName: row.file_name,
    fileMime: row.file_mime,
  }));
}

export async function getDoc(sql: Sql, userId: string, id: string): Promise<Document | null> {
  const rows = await sql<DocRow>`
    select id, title, kind, portfolio_id, content, file_name, file_mime, file_data, file_key, file_size, links_json, pinned,
      created_at, updated_at, created_by, updated_by, deleted
    from vault_doc where user_id = ${userId} and id = ${id} and not deleted limit 1
  `;
  return rows[0] ? toDocument(rows[0]) : null;
}

async function portfolioExists(sql: Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from vault_portfolio where user_id = ${userId} and id = ${id} and not deleted limit 1
  `;
  return rows.length > 0;
}

/** Choose an unused title because wiki links resolve by title. */
async function freeTitle(
  sql: Sql,
  userId: string,
  base: string,
  exceptId?: string,
): Promise<string> {
  const clean = base.trim().replace(/\s+/g, " ").slice(0, 200) || "Sin título";
  const rows = await sql<{ title: string }>`
    select title from vault_doc
    where user_id = ${userId} and not deleted and kind = 'markdown' and id <> ${exceptId ?? ""}
      and (lower(title) = lower(${clean}) or lower(title) like lower(${`${clean} %`}))
  `;
  const taken = new Set(rows.map((row) => row.title.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let index = 2;
  while (taken.has(`${clean} ${index}`.toLowerCase())) index += 1;
  return `${clean} ${index}`;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function createNote(
  sql: Sql,
  userId: string,
  input: { title: string; content: string; portfolioId: string | null; actor: string },
): Promise<Document> {
  if (input.content.length > MAX_CONTENT) throw new VaultError("La nota es demasiado larga.");
  if (input.portfolioId && !(await portfolioExists(sql, userId, input.portfolioId))) {
    throw new VaultError("Ese portafolio no existe.", 404);
  }
  const title = await freeTitle(sql, userId, input.title);
  const now = Date.now();
  const content = input.content.trim() ? input.content : `# ${title}\n\n`;
  const doc: Document = {
    id: crypto.randomUUID(),
    title,
    kind: "markdown",
    portfolioId: input.portfolioId,
    content,
    file: null,
    links: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    createdBy: input.actor,
    updatedBy: input.actor,
  };
  await writeDoc(sql, userId, doc, await nextRevision(sql, userId), false);
  return doc;
}

export async function updateNote(
  sql: Sql,
  userId: string,
  id: string,
  input: {
    title?: string;
    content?: string;
    portfolioId?: string | null;
    actor: string;
    /** Non-owner mutation actor for email notifications. */
    actorId?: string;
    separateVersion?: boolean;
  },
): Promise<Document> {
  const current = await getDoc(sql, userId, id);
  if (!current) throw new VaultError("Esa nota no existe.", 404);
  if (input.content !== undefined && current.kind !== "markdown")
    throw new VaultError("Un archivo no tiene texto que editar.");
  if (input.content !== undefined && input.content.length > MAX_CONTENT)
    throw new VaultError("La nota es demasiado larga.");
  if (input.portfolioId && !(await portfolioExists(sql, userId, input.portfolioId))) {
    throw new VaultError("Ese portafolio no existe.", 404);
  }
  const rev = await nextRevision(sql, userId);
  const now = Date.now();
  let title = current.title;
  if (input.title !== undefined && input.title.trim() && input.title.trim() !== current.title) {
    title = await freeTitle(sql, userId, input.title, id);
    // Renaming updates wiki links referencing the previous title, matching browser behavior.
    const others = await sql<{ id: string; content: string }>`
      select id, content from vault_doc
      where user_id = ${userId} and not deleted and kind = 'markdown' and id <> ${id} and content ilike ${likeTerm(current.title)}
    `;
    for (const other of others) {
      const next = replaceWikiTitle(other.content, current.title, title);
      if (next === other.content) continue;
      await sql`
        update vault_doc set content = ${next}, updated_at = ${now}, updated_by = ${input.actor}, rev = ${rev}
        where user_id = ${userId} and id = ${other.id}
      `;
    }
  }
  const doc: Document = {
    ...current,
    title,
    content: input.content ?? current.content,
    portfolioId: input.portfolioId !== undefined ? input.portfolioId : current.portfolioId,
    updatedAt: now,
    updatedBy: input.actor,
  };
  await writeDoc(sql, userId, doc, rev, false, input.separateVersion, input.actorId ?? userId);
  return doc;
}

/**
 * Store a manual link on the owner's document and advance the revision. File bytes stay. A PDF
 * does not gain a note version. "full" means the document already has the link limit.
 */
export async function attachManualLink(
  sql: Sql,
  userId: string,
  docId: string,
  link: ManualLink,
  actor: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = await getDoc(sql, userId, docId);
  if (!current) return { ok: false, error: "No lo encontré entre lo que puedes abrir." };
  if (link.targetId === docId && link.target !== "portfolio") {
    return { ok: false, error: "Un documento no se vincula consigo mismo." };
  }
  const links = withManualLink(current.links, link);
  if (links === "full") return { ok: false, error: "Hay demasiados vínculos en este documento." };
  const now = Date.now();
  await writeDoc(
    sql,
    userId,
    { ...current, links, updatedAt: now, updatedBy: actor },
    await nextRevision(sql, userId),
    false,
  );
  return { ok: true };
}

export async function deleteDoc(sql: Sql, userId: string, id: string): Promise<void> {
  const current = await getDoc(sql, userId, id);
  if (!current) throw new VaultError("Ese documento no existe.", 404);
  await pushChanges(sql, userId, {
    docs: [],
    deletedDocs: [id],
    portfolios: [],
    deletedPortfolios: [],
  });
}

/**
 * Move a portfolio, its nested portfolios and the documents inside them to the trash. Bytes stay
 * until purge. Null when the portfolio is already gone.
 */
export async function trashPortfolio(
  sql: Sql,
  userId: string,
  portfolioId: string,
): Promise<{ portfolios: number; documents: number } | null> {
  const portfolios = await listPortfolios(sql, userId);
  if (!portfolios.some((portfolio) => portfolio.id === portfolioId)) return null;
  const folderIds = [...descendantIds(portfolios, portfolioId)];
  const documents = await sql<{ id: string }>`
    select id from vault_doc
    where user_id = ${userId} and not deleted
      and portfolio_id = any(string_to_array(${folderIds.join(",")}, ","))
  `;
  await pushChanges(sql, userId, {
    docs: [],
    deletedDocs: documents.map((row) => row.id),
    portfolios: [],
    deletedPortfolios: folderIds,
  });
  return { portfolios: folderIds.length, documents: documents.length };
}

export async function createPortfolio(
  sql: Sql,
  userId: string,
  input: { name: string; parentId: string | null },
): Promise<Portfolio> {
  const name = input.name.trim().replace(/[\\/]/g, "").slice(0, 120);
  if (!name) throw new VaultError("Escribe un nombre.");
  if (input.parentId && !(await portfolioExists(sql, userId, input.parentId))) {
    throw new VaultError("El portafolio padre no existe.", 404);
  }
  const taken = await sql<{ id: string }>`
    select id from vault_portfolio
    where user_id = ${userId} and not deleted and lower(name) = lower(${name})
      and coalesce(parent_id, '') = coalesce(${input.parentId}, '')
    limit 1
  `;
  if (taken[0]) throw new VaultError("Ya hay un portafolio con ese nombre ahí.", 409);
  const portfolio: Portfolio = { id: crypto.randomUUID(), name, parentId: input.parentId };
  await pushChanges(sql, userId, {
    docs: [],
    deletedDocs: [],
    portfolios: [portfolio],
    deletedPortfolios: [],
  });
  return portfolio;
}

/**
 * Replace file content after Office saves or restores. The new object already exists; retain
 * the old one in history.
 */
export async function replaceFile(
  sql: Sql,
  userId: string,
  id: string,
  input: {
    key: string;
    size: number;
    actor: string;
    actorId?: string;
    separateVersion?: boolean;
    autosave?: boolean;
  },
): Promise<Document> {
  const current = await getDoc(sql, userId, id);
  if (!current?.file?.key) throw new VaultError("Ese archivo no existe.", 404);
  await ensureFileBaseline(sql, userId, {
    id,
    title: current.title,
    key: current.file.key,
    size: current.file.size ?? 0,
    author: current.updatedBy,
    at: current.updatedAt,
  });
  const now = Date.now();
  const rev = await nextRevision(sql, userId);
  await sql`
    update vault_doc set file_key = ${input.key}, file_size = ${input.size}, updated_at = ${now}, updated_by = ${input.actor},
      rev = ${rev}
    where user_id = ${userId} and id = ${id}
  `;
  await recordFileVersion(sql, userId, {
    id,
    title: current.title,
    key: input.key,
    size: input.size,
    author: input.actor,
    at: now,
    separate: input.separateVersion,
    autosave: input.autosave,
  });
  await noteChange(sql, {
    ownerId: userId,
    docId: id,
    actorId: input.actorId ?? userId,
    actorName: input.actor,
  });
  const doc = await getDoc(sql, userId, id);
  if (!doc) throw new VaultError("Ese archivo no existe.", 404);
  return doc;
}

// Trash.

export type TrashItem = {
  id: string;
  title: string;
  kind: "markdown" | "file" | "portfolio";
  portfolioName: string | null;
  deletedAt: number;
  /** Number of documents restored with a portfolio. */
  count?: number;
};

type TrashedPortfolio = { id: string; name: string; parent_id: string | null; deleted_at: unknown };

/** Deleted portfolios still recoverable from trash. */
async function trashedPortfolios(sql: Sql, userId: string): Promise<TrashedPortfolio[]> {
  return sql<TrashedPortfolio>`
    select id, name, parent_id, deleted_at from vault_portfolio
    where user_id = ${userId} and deleted and deleted_at is not null
  `;
}

/** ID and its trashed descendant portfolios. */
function trashedSubtree(trashed: TrashedPortfolio[], id: string): Set<string> {
  return descendantIds(
    trashed.map((portfolio) => ({ id: portfolio.id, parentId: portfolio.parent_id })),
    id,
  );
}

/**
 * List deleted portfolios once with their contents; list individually deleted documents only
 * when their portfolio survives.
 */
export async function listTrash(sql: Sql, userId: string): Promise<TrashItem[]> {
  await purgeExpired(sql, userId);
  const trashed = await trashedPortfolios(sql, userId);
  const trashedIds = new Set(trashed.map((portfolio) => portfolio.id));
  const rows = await sql<{
    id: string;
    title: string;
    kind: "markdown" | "file";
    portfolio_id: string | null;
    portfolio_name: string | null;
    deleted_at: unknown;
  }>`
    select d.id, d.title, d.kind, d.portfolio_id, p.name as portfolio_name, d.deleted_at
    from vault_doc d
    left join vault_portfolio p on p.user_id = d.user_id and p.id = d.portfolio_id
    where d.user_id = ${userId} and d.deleted and d.deleted_at is not null
  `;
  const names = await sql<{
    id: string;
    name: string;
  }>`select id, name from vault_portfolio where user_id = ${userId}`;
  const nameOf = (id: string | null) =>
    id ? (names.find((row) => row.id === id)?.name ?? null) : null;
  const docs: TrashItem[] = rows
    .filter((row) => !row.portfolio_id || !trashedIds.has(row.portfolio_id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      portfolioName: row.portfolio_name,
      deletedAt: Number(row.deleted_at),
    }));
  const portfolios: TrashItem[] = trashed
    .filter((portfolio) => !portfolio.parent_id || !trashedIds.has(portfolio.parent_id))
    .map((portfolio) => {
      const inside = trashedSubtree(trashed, portfolio.id);
      return {
        id: portfolio.id,
        title: portfolio.name,
        kind: "portfolio" as const,
        portfolioName: nameOf(portfolio.parent_id),
        deletedAt: Number(portfolio.deleted_at),
        count: rows.filter((row) => row.portfolio_id && inside.has(row.portfolio_id)).length,
      };
    });
  return [...portfolios, ...docs].sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Restore deleted portfolio ancestors. Return the original destination or root if an ancestor
 * was permanently removed.
 */
async function reviveParents(
  sql: Sql,
  userId: string,
  portfolioId: string | null,
  rev: number,
): Promise<string | null> {
  let cursor = portfolioId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const found = await sql<{ parent_id: string | null; deleted: unknown; deleted_at: unknown }>`
      select parent_id, deleted, deleted_at from vault_portfolio where user_id = ${userId} and id = ${cursor} limit 1
    `;
    const folder = found[0];
    if (!folder || (flag(folder.deleted) && folder.deleted_at == null)) return null;
    if (flag(folder.deleted)) {
      await sql`
        update vault_portfolio set deleted = false, deleted_at = null, rev = ${rev}
        where user_id = ${userId} and id = ${cursor}
      `;
    }
    cursor = folder.parent_id;
  }
  return portfolioId;
}

/** Restore a document and any trashed ancestors; fall back to root when its portfolio no longer exists. */
export async function restoreFromTrash(
  sql: Sql,
  userId: string,
  id: string,
  actor: string,
): Promise<Document> {
  const rows = await sql<{ title: string; kind: string; portfolio_id: string | null }>`
    select title, kind, portfolio_id from vault_doc
    where user_id = ${userId} and id = ${id} and deleted and deleted_at is not null limit 1
  `;
  const row = rows[0];
  if (!row) throw new VaultError("Ese documento ya no está en la papelera.", 404);
  const rev = await nextRevision(sql, userId);
  const portfolioId = await reviveParents(sql, userId, row.portfolio_id, rev);
  await reviveDoc(sql, userId, id, row, portfolioId, actor, rev);
  const doc = await getDoc(sql, userId, id);
  if (!doc) throw new VaultError("No se pudo recuperar.", 500);
  return doc;
}

async function reviveDoc(
  sql: Sql,
  userId: string,
  id: string,
  row: { title: string; kind: string },
  portfolioId: string | null,
  actor: string,
  rev: number,
): Promise<void> {
  const title = row.kind === "markdown" ? await freeTitle(sql, userId, row.title, id) : row.title;
  await sql`
    update vault_doc set deleted = false, deleted_at = null, title = ${title}, portfolio_id = ${portfolioId},
      updated_at = ${Date.now()}, updated_by = ${actor}, rev = ${rev}
    where user_id = ${userId} and id = ${id}
  `;
}

/**
 * Restore a portfolio subtree and trashed ancestors, falling back to root if an ancestor was
 * permanently removed.
 */
async function restorePortfolio(
  sql: Sql,
  userId: string,
  id: string,
  actor: string,
): Promise<void> {
  const trashed = await trashedPortfolios(sql, userId);
  const portfolio = trashed.find((item) => item.id === id);
  if (!portfolio) throw new VaultError("Ese portafolio ya no está en la papelera.", 404);
  const rev = await nextRevision(sql, userId);
  const parentId = await reviveParents(sql, userId, portfolio.parent_id, rev);
  for (const folder of trashedSubtree(trashed, id)) {
    await sql`
      update vault_portfolio set deleted = false, deleted_at = null, rev = ${rev}
      where user_id = ${userId} and id = ${folder}
    `;
    const docs = await sql<{ id: string; title: string; kind: string }>`
      select id, title, kind from vault_doc
      where user_id = ${userId} and deleted and deleted_at is not null and portfolio_id = ${folder}
    `;
    for (const doc of docs) await reviveDoc(sql, userId, doc.id, doc, folder, actor, rev);
  }
  await sql`update vault_portfolio set parent_id = ${parentId} where user_id = ${userId} and id = ${id}`;
}

/** Restore one trashed document or portfolio; see listTrash. */
export async function restoreTrashItem(
  sql: Sql,
  userId: string,
  id: string,
  actor: string,
): Promise<{ id: string; kind: "document" | "portfolio" }> {
  const trashed = await trashedPortfolios(sql, userId);
  if (trashed.some((portfolio) => portfolio.id === id)) {
    await restorePortfolio(sql, userId, id, actor);
    return { id, kind: "portfolio" };
  }
  const doc = await restoreFromTrash(sql, userId, id, actor);
  return { id: doc.id, kind: "document" };
}

async function purgeDoc(sql: Sql, userId: string, id: string): Promise<void> {
  const keys = await sql<{ file_key: string | null }>`
    select file_key from vault_doc where user_id = ${userId} and id = ${id} and deleted
  `;
  const versions = await versionKeys(sql, userId, id);
  for (const key of new Set([keys[0]?.file_key, ...versions])) await removeFile(sql, key);
  await sql`
    update vault_doc set content = '', file_data = null, file_key = null, file_size = null, links_json = '[]',
      deleted_at = null
    where user_id = ${userId} and id = ${id} and deleted
  `;
  await sql`delete from vault_doc_version where user_id = ${userId} and doc_id = ${id}`;
  await purgeComments(sql, userId, id);
  await purgeSignatures(sql, userId, id);
  // Also remove table columns and rows; see table.ts.
  await sql`delete from data_meta where owner_id = ${userId} and doc_id = ${id}`;
  await sql`delete from data_form where owner_id = ${userId} and doc_id = ${id}`;
  await sql`delete from data_row where owner_id = ${userId} and doc_id = ${id}`;
  await sql`delete from data_row_history where owner_id = ${userId} and doc_id = ${id}`;
  await sql`delete from data_field where owner_id = ${userId} and doc_id = ${id}`;
}

/**
 * Permanently purge selected trash or all entries when IDs are omitted, including portfolio
 * descendants.
 */
export async function purgeTrash(sql: Sql, userId: string, ids?: string[]): Promise<void> {
  const targets = ids ?? (await listTrash(sql, userId)).map((item) => item.id);
  const trashed = await trashedPortfolios(sql, userId);
  for (const id of targets) {
    if (!trashed.some((portfolio) => portfolio.id === id)) {
      await purgeDoc(sql, userId, id);
      continue;
    }
    for (const folder of trashedSubtree(trashed, id)) {
      const docs = await sql<{ id: string }>`
        select id from vault_doc
        where user_id = ${userId} and deleted and deleted_at is not null and portfolio_id = ${folder}
      `;
      for (const doc of docs) await purgeDoc(sql, userId, doc.id);
      await sql`update vault_portfolio set deleted_at = null where user_id = ${userId} and id = ${folder}`;
    }
  }
}

/** Purge content older than TRASH_DAYS. */
async function purgeExpired(sql: Sql, userId: string): Promise<void> {
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  const expired = await sql<{ id: string }>`
    select id from vault_doc where user_id = ${userId} and deleted and deleted_at is not null and deleted_at < ${cutoff}
  `;
  if (expired.length > 0)
    await purgeTrash(
      sql,
      userId,
      expired.map((row) => row.id),
    );
  await sql`
    update vault_portfolio set deleted_at = null
    where user_id = ${userId} and deleted and deleted_at is not null and deleted_at < ${cutoff}
  `;
}
