import type { Sql } from "@/lib/db";
import { extractWikiLinks } from "@/domain/vault/links";
import type { ManualLink } from "@/domain/vault/types";

/**
 * Per-owner in-memory vault index retains metadata, links and wiki references without full
 * text. Cache by vault revision and fetch only rows with newer rev values. docContent reads
 * text on opening; each replica maintains its own revision-validated index.
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
  /** Referenced wiki titles for graph and mentions. */
  wikiLinks: string[];
};

type Entry = {
  revision: number;
  portfolios: Map<string, IndexPortfolio>;
  docs: Map<string, IndexDoc>;
  /** Build revision-specific lists once for all requests. */
  lists?: { portfolios: IndexPortfolio[]; documents: IndexDoc[] };
};

export type VaultIndex = {
  revision: number;
  portfolios: IndexPortfolio[];
  documents: IndexDoc[];
  docById: ReadonlyMap<string, IndexDoc>;
};

/** Maximum cached owners, retaining recently used entries. */
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
      ? links.filter(
          (link) =>
            link &&
            typeof link.targetId === "string" &&
            (link.kind === "referencia" || link.kind === "llama"),
        )
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
    file: row.file_name
      ? { name: row.file_name, mime: row.file_mime ?? "application/octet-stream" }
      : null,
    updatedBy: row.updated_by,
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    links: parseLinks(row.links_json),
    wikiLinks: row.kind === "markdown" && row.content ? extractWikiLinks(row.content) : [],
  };
}

/** Apply changes since the revision; minus one loads everything. */
async function apply(sql: Sql, ownerId: string, entry: Entry, since: number): Promise<void> {
  const portfolios = await sql<{
    id: string;
    name: string;
    parent_id: string | null;
    deleted: unknown;
  }>`
    select id, name, parent_id, deleted from vault_portfolio where user_id = ${ownerId} and rev > ${since}
  `;
  for (const row of portfolios) {
    if (flag(row.deleted)) entry.portfolios.delete(row.id);
    else entry.portfolios.set(row.id, { id: row.id, name: row.name, parentId: row.parent_id });
  }
  // Read text only to extract wiki links; do not retain it in the index.
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

/** Current owner vault index, or null without a server vault. */
export async function vaultIndex(sql: Sql, ownerId: string): Promise<VaultIndex | null> {
  const state = await sql<{
    revision: unknown;
  }>`select revision from vault_state where user_id = ${ownerId} limit 1`;
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
  // Move recently used owners to the end; evict oldest first.
  cache.delete(ownerId);
  cache.set(ownerId, entry);
  while (cache.size > MAX_OWNERS) cache.delete(cache.keys().next().value!);
  entry.lists ??= {
    portfolios: [...entry.portfolios.values()],
    documents: [...entry.docs.values()],
  };
  return { revision, ...entry.lists, docById: entry.docs };
}

/** Live document text from the owner's vault. */
export async function docContent(
  sql: Sql,
  ownerId: string,
  docId: string,
): Promise<{ content: string; updatedAt: string; updatedBy: string } | null> {
  const rows = await sql<{ content: string; updated_at: unknown; updated_by: string }>`
    select content, updated_at, updated_by from vault_doc where user_id = ${ownerId} and id = ${docId} and not deleted limit 1
  `;
  const row = rows[0];
  return row
    ? {
        content: row.content,
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
        updatedBy: row.updated_by,
      }
    : null;
}

/** Test-only index reset. */
export function clearVaultIndex(): void {
  cache.clear();
}
