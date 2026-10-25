import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { coveredBy, coveredByAll, type ShareKind, type ShareTarget } from "@/domain/share";

/**
 * Acceso a datos de lo compartido (solo servidor). Ver `migrations/0006_share.sql`
 * y `0007_orgs_auth.sql`.
 *
 * Un usuario ve un elemento compartido si es su dueño, si fue invitado
 * directamente (`share_grant`) o si pertenece a una organización invitada o a
 * cualquiera de sus sub-organizaciones (`share_org_grant`). Esto último se
 * resuelve subiendo desde las organizaciones del usuario hasta sus raíces.
 */

export type ShareRow = {
  id: string;
  kind: ShareKind;
  targetId: string;
  title: string;
  visibility: "shared" | "public";
  publicToken: string | null;
};

export type PublishedDoc = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  content: string;
  file: { name: string; mime: string; dataUrl: string } | null;
  updatedBy: string;
  updatedAt: string;
};

export type PublishedPortfolio = { id: string; name: string; parentId: string | null };

/** Lo que ve quien abre un elemento compartido: el elemento y su contenido. */
export type SharedTree = {
  share: { id: string; kind: ShareKind; title: string; ownerName: string; visibility: "shared" | "public" };
  portfolios: PublishedPortfolio[];
  documents: PublishedDoc[];
};

type ItemRecord = {
  id: string;
  owner_id: string;
  kind: ShareKind;
  target_id: string;
  title: string;
  visibility: "shared" | "public";
  public_token: string | null;
};

function toRow(item: ItemRecord): ShareRow {
  return {
    id: item.id,
    kind: item.kind,
    targetId: item.target_id,
    title: item.title,
    visibility: item.visibility,
    publicToken: item.public_token,
  };
}

/** Enlace público difícil de adivinar (192 bits). */
function newPublicToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function ownerShares(
  sql: Sql,
  ownerId: string,
): Promise<(ShareRow & { userIds: string[]; orgIds: string[] })[]> {
  const items = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, public_token
    from share_item where owner_id = ${ownerId}
  `;
  const grants = await sql<{ share_id: string; user_id: string }>`
    select g.share_id, g.user_id from share_grant g
    join share_item s on s.id = g.share_id
    where s.owner_id = ${ownerId}
  `;
  const orgGrants = await sql<{ share_id: string; org_id: string }>`
    select g.share_id, g.org_id from share_org_grant g
    join share_item s on s.id = g.share_id
    where s.owner_id = ${ownerId}
  `;
  return items.map((item) => ({
    ...toRow(item),
    userIds: grants.filter((grant) => grant.share_id === item.id).map((grant) => grant.user_id),
    orgIds: orgGrants.filter((grant) => grant.share_id === item.id).map((grant) => grant.org_id),
  }));
}

/** Crea, cambia o quita (privado) la visibilidad de una nota o portafolio del dueño. */
export async function writeShare(
  sql: Sql,
  ownerId: string,
  input: ShareTarget & {
    title: string;
    visibility: "private" | "shared" | "public";
    userIds: string[];
    orgIds: string[];
  },
): Promise<void> {
  const existing = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, public_token from share_item
    where owner_id = ${ownerId} and kind = ${input.kind} and target_id = ${input.targetId}
    limit 1
  `;
  const current = existing[0];
  if (input.visibility === "private") {
    if (current) await sql`delete from share_item where id = ${current.id}`;
    await prunePublished(sql, ownerId);
    return;
  }
  const token = input.visibility === "public" ? (current?.public_token ?? newPublicToken()) : null;
  const id = current?.id ?? randomUUID();
  if (current) {
    await sql`
      update share_item
      set title = ${input.title}, visibility = ${input.visibility}, public_token = ${token}, updated_at = now()
      where id = ${id}
    `;
  } else {
    await sql`
      insert into share_item (id, owner_id, kind, target_id, title, visibility, public_token)
      values (${id}, ${ownerId}, ${input.kind}, ${input.targetId}, ${input.title}, ${input.visibility}, ${token})
    `;
  }
  await sql`delete from share_grant where share_id = ${id}`;
  await sql`delete from share_org_grant where share_id = ${id}`;
  if (input.visibility === "shared") {
    for (const orgId of new Set(input.orgIds)) {
      await sql`
        insert into share_org_grant (share_id, org_id)
        select ${id}, o.id from app_org o where o.id = ${orgId}
        on conflict do nothing
      `;
    }
    for (const userId of new Set(input.userIds)) {
      if (userId === ownerId) continue;
      await sql`
        insert into share_grant (share_id, user_id)
        select ${id}, id from "user" where id = ${userId}
        on conflict do nothing
      `;
    }
  }
}

/**
 * Reemplaza la copia publicada del dueño con lo que hoy cubren sus elementos
 * compartidos. Lo que el cliente mande de más se descarta, y los elementos
 * cuya nota o portafolio ya no existe en la bóveda se quitan.
 */
export async function writePublished(
  sql: Sql,
  ownerId: string,
  vault: { documentIds: string[]; portfolios: PublishedPortfolio[]; documents: PublishedDoc[] },
): Promise<void> {
  const known = new Set(vault.documentIds);
  const portfolioIds = new Set(vault.portfolios.map((portfolio) => portfolio.id));
  for (const share of await ownerShares(sql, ownerId)) {
    const gone = share.kind === "document" ? !known.has(share.targetId) : !portfolioIds.has(share.targetId);
    if (gone) await sql`delete from share_item where id = ${share.id}`;
  }
  const shares = await ownerShares(sql, ownerId);
  const covered = coveredByAll(shares, vault.portfolios, vault.documents);
  await sql`delete from published_doc where owner_id = ${ownerId}`;
  await sql`delete from published_portfolio where owner_id = ${ownerId}`;
  for (const portfolio of vault.portfolios) {
    if (!covered.portfolioIds.has(portfolio.id)) continue;
    await sql`
      insert into published_portfolio (owner_id, portfolio_id, name, parent_id)
      values (${ownerId}, ${portfolio.id}, ${portfolio.name}, ${portfolio.parentId})
    `;
  }
  for (const document of vault.documents) {
    if (!covered.documentIds.has(document.id)) continue;
    await sql`
      insert into published_doc
        (owner_id, doc_id, title, kind, portfolio_id, content, file_name, file_mime, file_data, updated_by, updated_at)
      values (
        ${ownerId}, ${document.id}, ${document.title}, ${document.kind}, ${document.portfolioId},
        ${document.content}, ${document.file?.name ?? null}, ${document.file?.mime ?? null},
        ${document.file?.dataUrl ?? null}, ${document.updatedBy}, now()
      )
    `;
  }
  for (const share of shares) {
    const title =
      share.kind === "document"
        ? vault.documents.find((document) => document.id === share.targetId)?.title
        : vault.portfolios.find((portfolio) => portfolio.id === share.targetId)?.name;
    if (title && title !== share.title) {
      await sql`update share_item set title = ${title} where id = ${share.id}`;
    }
  }
}

/** Borra de la copia publicada lo que ya no cubre ningún elemento compartido. */
async function prunePublished(sql: Sql, ownerId: string): Promise<void> {
  const shares = await ownerShares(sql, ownerId);
  const portfolios = await readPortfolios(sql, ownerId);
  const documents = await readDocs(sql, ownerId, false);
  const covered = coveredByAll(shares, portfolios, documents);
  for (const document of documents) {
    if (!covered.documentIds.has(document.id)) {
      await sql`delete from published_doc where owner_id = ${ownerId} and doc_id = ${document.id}`;
    }
  }
  for (const portfolio of portfolios) {
    if (!covered.portfolioIds.has(portfolio.id)) {
      await sql`delete from published_portfolio where owner_id = ${ownerId} and portfolio_id = ${portfolio.id}`;
    }
  }
}

async function readPortfolios(sql: Sql, ownerId: string): Promise<PublishedPortfolio[]> {
  const rows = await sql<{ portfolio_id: string; name: string; parent_id: string | null }>`
    select portfolio_id, name, parent_id from published_portfolio where owner_id = ${ownerId}
  `;
  return rows.map((row) => ({ id: row.portfolio_id, name: row.name, parentId: row.parent_id }));
}

async function readDocs(sql: Sql, ownerId: string, withFiles: boolean): Promise<PublishedDoc[]> {
  const rows = await sql<{
    doc_id: string;
    title: string;
    kind: "markdown" | "file";
    portfolio_id: string | null;
    content: string;
    file_name: string | null;
    file_mime: string | null;
    file_data: string | null;
    updated_by: string;
    updated_at: unknown;
  }>`
    select doc_id, title, kind, portfolio_id, content, file_name, file_mime,
      case when ${withFiles} then file_data else null end as file_data, updated_by, updated_at
    from published_doc where owner_id = ${ownerId}
  `;
  return rows.map((row) => ({
    id: row.doc_id,
    title: row.title,
    kind: row.kind,
    portfolioId: row.portfolio_id,
    content: row.content,
    file: row.file_name ? { name: row.file_name, mime: row.file_mime ?? "application/octet-stream", dataUrl: row.file_data ?? "" } : null,
    updatedBy: row.updated_by,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }));
}

async function ownerName(sql: Sql, ownerId: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from "user" where id = ${ownerId} limit 1`;
  return rows[0]?.name?.trim() || "Alguien";
}

/** Contenido de un elemento compartido, listo para la vista de solo lectura. */
async function treeFor(sql: Sql, item: ItemRecord): Promise<SharedTree> {
  const portfolios = await readPortfolios(sql, item.owner_id);
  const documents = await readDocs(sql, item.owner_id, true);
  const covered = coveredBy({ kind: item.kind, targetId: item.target_id }, portfolios, documents);
  return {
    share: {
      id: item.id,
      kind: item.kind,
      title: item.title,
      ownerName: await ownerName(sql, item.owner_id),
      visibility: item.visibility,
    },
    portfolios: portfolios.filter((portfolio) => covered.portfolioIds.has(portfolio.id)),
    documents: documents.filter((document) => covered.documentIds.has(document.id)),
  };
}

/** Lo que otros compartieron con `userId` (no incluye lo público por enlace). */
export async function sharedWith(
  sql: Sql,
  userId: string,
): Promise<{ id: string; kind: ShareKind; title: string; ownerName: string }[]> {
  const rows = await sql<{ id: string; kind: ShareKind; title: string; owner_name: string }>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.id, s.kind, s.title, u.name as owner_name
    from share_item s
    join "user" u on u.id = s.owner_id
    where s.visibility = 'shared'
      and s.owner_id <> ${userId}
      and (
        exists (select 1 from share_grant g where g.share_id = s.id and g.user_id = ${userId})
        or exists (select 1 from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine))
      )
    order by u.name, s.title
  `;
  return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, ownerName: row.owner_name?.trim() || "Alguien" }));
}

/** Un elemento compartido, si `userId` es su dueño o fue invitado. */
export async function openForUser(sql: Sql, userId: string, shareId: string): Promise<SharedTree | null> {
  const rows = await sql<ItemRecord>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.id, s.owner_id, s.kind, s.target_id, s.title, s.visibility, s.public_token
    from share_item s
    where s.id = ${shareId}
      and (
        s.owner_id = ${userId}
        or (s.visibility = 'shared' and (
          exists (select 1 from share_grant g where g.share_id = s.id and g.user_id = ${userId})
          or exists (select 1 from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine))
        ))
      )
    limit 1
  `;
  return rows[0] ? treeFor(sql, rows[0]) : null;
}

/** Un elemento público, por su enlace. Sin sesión. */
export async function openByToken(sql: Sql, token: string): Promise<SharedTree | null> {
  const rows = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, public_token
    from share_item where public_token = ${token} and visibility = 'public'
    limit 1
  `;
  return rows[0] ? treeFor(sql, rows[0]) : null;
}

/** Organizaciones con las que se puede compartir. */
export async function shareOrgCandidates(sql: Sql): Promise<{ id: string; name: string; parentId: string | null }[]> {
  const rows = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from app_org order by name
  `;
  return rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id }));
}

/** Usuarios con quienes se puede compartir (todos menos uno mismo). */
export async function shareCandidates(sql: Sql, userId: string): Promise<{ id: string; name: string; loginName: string }[]> {
  const rows = await sql<{ id: string; name: string; login_name: string | null }>`
    select u.id, u.name, coalesce(m.login_name, a.login_name) as login_name
    from "user" u
    left join app_user_role m on m.user_id = u.id
    left join app_admin a on a.user_id = u.id
    where u.id <> ${userId}
    order by u.name
  `;
  return rows.map((row) => ({ id: row.id, name: row.name?.trim() || "Sin nombre", loginName: row.login_name ?? "" }));
}
