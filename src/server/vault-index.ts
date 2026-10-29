import type { Sql } from "@/lib/db";
import { extractWikiLinks } from "@/domain/vault/links";
import type { ManualLink } from "@/domain/vault/types";

/**
 * Índice en memoria de la bóveda de un dueño, para lo compartido (solo
 * servidor): sus portafolios y, de cada documento, lo necesario para el
 * índice, el grafo y los vínculos (título, portafolio, archivo, vínculos
 * manuales y los `[[títulos]]` que nombra), sin el texto completo, que se
 * pide al abrir el documento (`docContent`).
 *
 * Abrir un espacio de trabajo con miles de documentos ya no lee todo su
 * contenido cada vez: se guarda por dueño junto a su revisión
 * (`vault_state.revision`) y, si cambió, se leen solo las filas con `rev`
 * mayor (igual que la sincronización de los dispositivos). Cada proceso tiene
 * el suyo; la revisión hace que nunca quede atrasado.
 */

export type IndexPortfolio = { id: string; name: string; parentId: string | null };

export type IndexDoc = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  file: { name: string; mime: string } | null;
  updatedBy: string;
  updatedAt: string;
  links: ManualLink[];
  /** Los `[[títulos]]` que nombra (para el grafo y las menciones). */
  wikiLinks: string[];
};

type Entry = {
  revision: number;
  portfolios: Map<string, IndexPortfolio>;
  docs: Map<string, IndexDoc>;
  /** Las listas de esta revisión, armadas una vez para todas las peticiones. */
  lists?: { portfolios: IndexPortfolio[]; documents: IndexDoc[] };
};

export type VaultIndex = {
  revision: number;
  portfolios: IndexPortfolio[];
  documents: IndexDoc[];
  docById: ReadonlyMap<string, IndexDoc>;
};

/** Dueños guardados a la vez (los que más se usan quedan). */
const MAX_OWNERS = 200;
const cache = new Map<string, Entry>();

type DocRow = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolio_id: string | null;
  content: string | null;
  file_name: string | null;
  file_mime: string | null;
  links_json: string | null;
  updated_by: string;
  updated_at: unknown;
  deleted: unknown;
};

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

export function parseLinks(raw: string | null): ManualLink[] {
  try {
    const links = JSON.parse(raw ?? "[]") as ManualLink[];
    return Array.isArray(links)
      ? links.filter((link) => link && typeof link.targetId === "string" && (link.kind === "referencia" || link.kind === "llama"))
      : [];
  } catch {
    return [];
  }
}

function toDoc(row: DocRow): IndexDoc {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    portfolioId: row.portfolio_id,
    file: row.file_name ? { name: row.file_name, mime: row.file_mime ?? "application/octet-stream" } : null,
    updatedBy: row.updated_by,
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    links: parseLinks(row.links_json),
    wikiLinks: row.kind === "markdown" && row.content ? extractWikiLinks(row.content) : [],
  };
}

/** Aplica lo cambiado desde `since` (-1: todo). */
async function apply(sql: Sql, ownerId: string, entry: Entry, since: number): Promise<void> {
  const portfolios = await sql<{ id: string; name: string; parent_id: string | null; deleted: unknown }>`
    select id, name, parent_id, deleted from vault_portfolio where user_id = ${ownerId} and rev > ${since}
  `;
  for (const row of portfolios) {
    if (flag(row.deleted)) entry.portfolios.delete(row.id);
    else entry.portfolios.set(row.id, { id: row.id, name: row.name, parentId: row.parent_id });
  }
  // El texto solo se lee para sacar sus `[[vínculos]]`; no se guarda.
  const docs = await sql<DocRow>`
    select id, title, kind, portfolio_id, case when kind = 'markdown' then content else null end as content,
      file_name, file_mime, links_json, updated_by, updated_at, deleted
    from vault_doc where user_id = ${ownerId} and rev > ${since}
  `;
  for (const row of docs) {
    if (flag(row.deleted)) entry.docs.delete(row.id);
    else entry.docs.set(row.id, toDoc(row));
  }
}

/** El índice de la bóveda de `ownerId`, al día; null si no tiene bóveda en el servidor. */
export async function vaultIndex(
  sql: Sql,
  ownerId: string,
): Promise<VaultIndex | null> {
  const state = await sql<{ revision: unknown }>`select revision from vault_state where user_id = ${ownerId} limit 1`;
  if (!state[0]) {
    cache.delete(ownerId);
    return null;
  }
  const revision = Number(state[0].revision);
  let entry = cache.get(ownerId);
  if (!entry || revision < entry.revision) {
    entry = { revision: -1, portfolios: new Map(), docs: new Map() };
    await apply(sql, ownerId, entry, -1);
  } else if (revision > entry.revision) {
    await apply(sql, ownerId, entry, entry.revision);
    entry.lists = undefined;
  }
  entry.revision = revision;
  // Recién usado: al final (los primeros son los que se descartan).
  cache.delete(ownerId);
  cache.set(ownerId, entry);
  while (cache.size > MAX_OWNERS) cache.delete(cache.keys().next().value!);
  entry.lists ??= { portfolios: [...entry.portfolios.values()], documents: [...entry.docs.values()] };
  return { revision, ...entry.lists, docById: entry.docs };
}

/** El texto de un documento (vivo) de la bóveda de `ownerId`. */
export async function docContent(
  sql: Sql,
  ownerId: string,
  docId: string,
): Promise<{ content: string; updatedAt: string; updatedBy: string } | null> {
  const rows = await sql<{ content: string; updated_at: unknown; updated_by: string }>`
    select content, updated_at, updated_by from vault_doc where user_id = ${ownerId} and id = ${docId} and not deleted limit 1
  `;
  const row = rows[0];
  return row ? { content: row.content, updatedAt: new Date(Number(row.updated_at)).toISOString(), updatedBy: row.updated_by } : null;
}

/** Solo para pruebas: vacía el índice. */
export function clearVaultIndex(): void {
  cache.clear();
}
