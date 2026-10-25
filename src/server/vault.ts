import type { Sql } from "@/lib/db";
import { replaceWikiTitle } from "@/domain/vault/links";
import type { Document, ManualLink, Portfolio } from "@/domain/vault/types";

/**
 * La bóveda de cada usuario en el servidor (solo servidor). Fuente de verdad
 * para la sincronización del navegador, la API REST (`/api/v1`) y las
 * herramientas de la IA. Ver `migrations/0008_vault_api_ai.sql`.
 *
 * Cada cambio recibe la siguiente revisión del usuario; las bajas quedan como
 * lápidas para que los demás navegadores las reciban.
 */

/** Límite del texto de una nota (~400 KB). */
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
    return Array.isArray(links) ? links.filter((link) => link && typeof link.targetId === "string") : [];
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
    file: row.file_name ? { name: row.file_name, mime: row.file_mime ?? "application/octet-stream", dataUrl: row.file_data ?? "" } : null,
    links: parseLinks(row.links_json),
    pinned: flag(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/** Reserva la siguiente revisión del usuario. */
async function nextRevision(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<{ revision: number }>`
    insert into vault_state (user_id, revision) values (${userId}, 1)
    on conflict (user_id) do update set revision = vault_state.revision + 1
    returning revision
  `;
  return Number(rows[0]!.revision);
}

export async function currentRevision(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<{ revision: number }>`select revision from vault_state where user_id = ${userId}`;
  return Number(rows[0]?.revision ?? 0);
}

async function writeDoc(sql: Sql, userId: string, doc: Document, rev: number, onlyIfNewer: boolean): Promise<void> {
  const file = doc.file;
  const links = JSON.stringify(doc.links ?? []);
  if (onlyIfNewer) {
    // Gana el cambio más reciente: un navegador atrasado no pisa lo que hizo la IA.
    await sql`
      insert into vault_doc (user_id, id, title, kind, portfolio_id, content, file_name, file_mime, file_data,
        links_json, pinned, created_at, updated_at, created_by, updated_by, rev, deleted)
      values (${userId}, ${doc.id}, ${doc.title}, ${doc.kind}, ${doc.portfolioId}, ${doc.content},
        ${file?.name ?? null}, ${file?.mime ?? null}, ${file?.dataUrl ?? null}, ${links}, ${doc.pinned},
        ${doc.createdAt}, ${doc.updatedAt}, ${doc.createdBy}, ${doc.updatedBy}, ${rev}, false)
      on conflict (user_id, id) do update set
        title = excluded.title, kind = excluded.kind, portfolio_id = excluded.portfolio_id,
        content = excluded.content, file_name = excluded.file_name, file_mime = excluded.file_mime,
        file_data = excluded.file_data, links_json = excluded.links_json, pinned = excluded.pinned,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by, rev = excluded.rev, deleted = false
      where vault_doc.deleted or vault_doc.updated_at <= excluded.updated_at
    `;
    return;
  }
  await sql`
    insert into vault_doc (user_id, id, title, kind, portfolio_id, content, file_name, file_mime, file_data,
      links_json, pinned, created_at, updated_at, created_by, updated_by, rev, deleted)
    values (${userId}, ${doc.id}, ${doc.title}, ${doc.kind}, ${doc.portfolioId}, ${doc.content},
      ${file?.name ?? null}, ${file?.mime ?? null}, ${file?.dataUrl ?? null}, ${links}, ${doc.pinned},
      ${doc.createdAt}, ${doc.updatedAt}, ${doc.createdBy}, ${doc.updatedBy}, ${rev}, false)
    on conflict (user_id, id) do update set
      title = excluded.title, kind = excluded.kind, portfolio_id = excluded.portfolio_id,
      content = excluded.content, file_name = excluded.file_name, file_mime = excluded.file_mime,
      file_data = excluded.file_data, links_json = excluded.links_json, pinned = excluded.pinned,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, rev = excluded.rev, deleted = false
  `;
}

// ---------------------------------------------------------------------------
// Sincronización con el navegador

export type VaultChanges = {
  docs: Document[];
  deletedDocs: string[];
  portfolios: Portfolio[];
  deletedPortfolios: string[];
};

/** Aplica lo que manda un navegador y devuelve la revisión nueva. */
export async function pushChanges(sql: Sql, userId: string, changes: VaultChanges): Promise<number> {
  const empty =
    changes.docs.length + changes.deletedDocs.length + changes.portfolios.length + changes.deletedPortfolios.length === 0;
  if (empty) return currentRevision(sql, userId);
  const rev = await nextRevision(sql, userId);
  for (const portfolio of changes.portfolios) {
    await sql`
      insert into vault_portfolio (user_id, id, name, parent_id, rev, deleted)
      values (${userId}, ${portfolio.id}, ${portfolio.name}, ${portfolio.parentId}, ${rev}, false)
      on conflict (user_id, id) do update set
        name = excluded.name, parent_id = excluded.parent_id, rev = excluded.rev, deleted = false
    `;
  }
  for (const id of changes.deletedPortfolios) {
    await sql`update vault_portfolio set deleted = true, rev = ${rev} where user_id = ${userId} and id = ${id}`;
  }
  for (const doc of changes.docs) await writeDoc(sql, userId, doc, rev, true);
  for (const id of changes.deletedDocs) {
    await sql`
      update vault_doc set deleted = true, content = '', file_data = null, rev = ${rev}
      where user_id = ${userId} and id = ${id}
    `;
  }
  return rev;
}

/** Cambios posteriores a `since` (incluidas las bajas). */
export async function pullChanges(sql: Sql, userId: string, since: number): Promise<VaultChanges & { revision: number }> {
  const revision = await currentRevision(sql, userId);
  const docs = await sql<DocRow>`
    select id, title, kind, portfolio_id, content, file_name, file_mime, file_data, links_json, pinned,
      created_at, updated_at, created_by, updated_by, deleted
    from vault_doc where user_id = ${userId} and rev > ${since}
  `;
  const portfolios = await sql<{ id: string; name: string; parent_id: string | null; deleted: unknown }>`
    select id, name, parent_id, deleted from vault_portfolio where user_id = ${userId} and rev > ${since}
  `;
  return {
    revision,
    docs: docs.filter((row) => !flag(row.deleted)).map(toDocument),
    deletedDocs: docs.filter((row) => flag(row.deleted)).map((row) => row.id),
    portfolios: portfolios
      .filter((row) => !flag(row.deleted))
      .map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id })),
    deletedPortfolios: portfolios.filter((row) => flag(row.deleted)).map((row) => row.id),
  };
}

// ---------------------------------------------------------------------------
// Lectura y escritura para la API y la IA

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
      and (${term === null} or title ilike ${term ?? ""} or content ilike ${term ?? ""})
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
    select id, title, kind, portfolio_id, content, file_name, file_mime, file_data, links_json, pinned,
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

/** Título libre: las notas se enlazan por título, así que no puede repetirse. */
async function freeTitle(sql: Sql, userId: string, base: string, exceptId?: string): Promise<string> {
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
  input: { title?: string; content?: string; portfolioId?: string | null; actor: string },
): Promise<Document> {
  const current = await getDoc(sql, userId, id);
  if (!current) throw new VaultError("Esa nota no existe.", 404);
  if (input.content !== undefined && current.kind !== "markdown") throw new VaultError("Un archivo no tiene texto que editar.");
  if (input.content !== undefined && input.content.length > MAX_CONTENT) throw new VaultError("La nota es demasiado larga.");
  if (input.portfolioId && !(await portfolioExists(sql, userId, input.portfolioId))) {
    throw new VaultError("Ese portafolio no existe.", 404);
  }
  const rev = await nextRevision(sql, userId);
  const now = Date.now();
  let title = current.title;
  if (input.title !== undefined && input.title.trim() && input.title.trim() !== current.title) {
    title = await freeTitle(sql, userId, input.title, id);
    // Como en el navegador: renombrar actualiza los [[enlaces]] que apuntaban al título viejo.
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
  await writeDoc(sql, userId, doc, rev, false);
  return doc;
}

export async function deleteDoc(sql: Sql, userId: string, id: string): Promise<void> {
  const current = await getDoc(sql, userId, id);
  if (!current) throw new VaultError("Ese documento no existe.", 404);
  await pushChanges(sql, userId, { docs: [], deletedDocs: [id], portfolios: [], deletedPortfolios: [] });
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
  await pushChanges(sql, userId, { docs: [], deletedDocs: [], portfolios: [portfolio], deletedPortfolios: [] });
  return portfolio;
}

/**
 * Decodifica un data URL (`data:<mime>[;param…][;base64],<datos>`). Sin
 * `;base64` los datos van como texto, normalmente con %-escapes.
 */
function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const data = match[3] ?? "";
  if (/;base64/i.test(match[2] ?? "")) return { mime: match[1] ?? "", bytes: Buffer.from(data, "base64") };
  let text = data;
  try {
    text = decodeURIComponent(data);
  } catch {
    /* sin escapes válidos: tal cual */
  }
  return { mime: match[1] ?? "", bytes: Buffer.from(text, "utf8") };
}

/** Texto legible de un archivo, si es de texto (Markdown, JSON, SVG, CSV…). */
export function fileText(doc: Document, max = 20_000): string | null {
  if (!doc.file?.dataUrl) return null;
  const decoded = decodeDataUrl(doc.file.dataUrl);
  if (!decoded) return null;
  const mime = (decoded.mime || doc.file.mime || "").toLowerCase();
  const textual =
    mime.startsWith("text/") || /json|xml|svg|csv|markdown|javascript|yaml/.test(mime) || /\.(md|txt|csv|json|svg|xml|ya?ml)$/i.test(doc.file.name);
  if (!textual) return null;
  const raw = decoded.bytes.toString("utf8");
  return raw.length > max ? `${raw.slice(0, max)}\n…(recortado)` : raw;
}

/** Bytes de un archivo, para descargarlo por la API. */
export function fileBytes(doc: Document): { mime: string; bytes: Buffer } | null {
  if (!doc.file?.dataUrl) return null;
  const decoded = decodeDataUrl(doc.file.dataUrl);
  return decoded ? { mime: decoded.mime || doc.file.mime, bytes: decoded.bytes } : null;
}
