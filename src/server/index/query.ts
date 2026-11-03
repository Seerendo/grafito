import type { Sql } from "@/lib/db";
import { findPassages, type Passage } from "@/domain/search-text";

/** Document containing the exact phrase, with an excerpt for each occurrence. */
export type ContentHit = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  snippet: string;
  passages: Passage[];
  more: number;
};

function likeTerm(value: string): string {
  const collapsed = value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\\%_]/g, "");
  return `%${collapsed}%`;
}

function asKind(value: string): "markdown" | "file" {
  return value === "file" ? "file" : "markdown";
}

type IndexedRow = {
  doc_id: string;
  title: string;
  kind: string;
  portfolio_id: string | null;
  body: string;
};

function plain(items: Passage[]): string {
  return items
    .slice(0, 4)
    .map((item) => `${item.before}${item.match}${item.after}`)
    .join("\n");
}

/** Search the entire phrase in actual note or extracted file text; individual words alone do not match. */
export async function queryContent(
  sql: Sql,
  ownerId: string,
  query: string,
): Promise<ContentHit[]> {
  const q = query.trim();
  const term = likeTerm(q);
  if (term.length < 4) return [];
  const rows = await sql<IndexedRow>`
    select doc_id, title, kind, portfolio_id, body from (
      select d.id as doc_id, d.title, d.kind, d.portfolio_id,
        case
          when d.kind = 'markdown' then coalesce(d.content, '')
          when d.file_name ilike '%.tabla' then coalesce(nullif(m.search_text, ''), i.body, '')
          when coalesce(i.body, '') <> '' then i.body
          else coalesce(m.search_text, '')
        end as body
      from vault_doc d
      left join doc_index i on i.user_id = d.user_id and i.doc_id = d.id
      left join data_meta m on m.owner_id = d.user_id and m.doc_id = d.id
      where d.user_id = ${ownerId} and not d.deleted
    ) found
    where regexp_replace(found.title, '[[:space:]]+', ' ', 'g') ilike ${term}
       or regexp_replace(found.body, '[[:space:]]+', ' ', 'g') ilike ${term}
    order by found.title
    limit 40
  `;
  const hits: ContentHit[] = [];
  for (const row of rows) {
    const body = findPassages(row.body, q);
    const title = findPassages(row.title, q);
    if (body.items.length === 0 && title.items.length === 0) continue;
    hits.push({
      id: row.doc_id,
      title: row.title,
      kind: asKind(row.kind),
      portfolioId: row.portfolio_id,
      snippet: plain(body.items.length > 0 ? body.items : title.items),
      passages: body.items,
      more: body.more,
    });
  }
  return hits;
}

/** Whether the caller may search ownerId's vault. */
export async function canSearchOwner(
  sql: Sql,
  viewerId: string,
  ownerId: string,
): Promise<boolean> {
  if (viewerId === ownerId) return true;
  const workspace = await sql<{ ok: number }>`
    select 1 as ok from workspace_access where owner_id = ${ownerId} and user_id = ${viewerId} limit 1
  `;
  if (workspace.length > 0) return true;
  const grant = await sql<{ ok: number }>`
    select 1 as ok from share_grant g
    join share_item s on s.id = g.share_id
    where g.user_id = ${viewerId} and s.owner_id = ${ownerId}
    limit 1
  `;
  if (grant.length > 0) return true;
  const org = await sql<{ ok: number }>`
    select 1 as ok from share_org_grant g
    join share_item s on s.id = g.share_id
    join app_org_member m on m.org_id = g.org_id
    where m.user_id = ${viewerId} and s.owner_id = ${ownerId}
    limit 1
  `;
  return org.length > 0;
}
