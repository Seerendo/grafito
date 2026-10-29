import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Sql } from "@/lib/db";
import { coveredBy, coveredByAll, type ShareKind, type ShareTarget } from "@/domain/share";
import { signedFileUrl } from "./file-links";
import { portfolioLineage } from "./space";
import { docContent, vaultIndex, type IndexDoc } from "./vault-index";
import { packBody, packBodyFrom, packDoc, type PackedTree } from "@/domain/share-pack";
import { descendantIds } from "@/domain/vault/portfolios";
import type { ManualLink } from "@/domain/vault/types";

/**
 * Acceso a datos de lo compartido (solo servidor). Ver `migrations/0006_share.sql`
 * y `0007_orgs_auth.sql`.
 *
 * Un usuario ve un elemento compartido si es su dueño, si fue invitado
 * directamente (`share_grant`) o si pertenece a una organización invitada o a
 * cualquiera de sus sub-organizaciones (`share_org_grant`). Esto último se
 * resuelve subiendo desde las organizaciones del usuario hasta sus raíces.
 *
 * Acceso: `read` (por defecto), `edit` (también crear notas y subir archivos
 * dentro de un portafolio) o `admin` (además reparte el espacio del portafolio
 * y cambia los permisos de los demás; ver `space.ts`). Puede fijarse por
 * invitado (`share_grant.access`); sin él vale el del elemento. Lo público
 * siempre es de solo lectura. Desde la migración 0008 el contenido se lee directamente de la
 * bóveda del dueño en el servidor (`vault_doc`); la copia publicada
 * (`published_*`) solo queda como respaldo para dueños sin bóveda en el servidor.
 */

export type ShareAccess = "read" | "edit" | "admin";

const RANK: Record<ShareAccess, number> = { read: 1, edit: 2, admin: 3 };

/** Si el nivel deja crear y cambiar contenido. */
export function canWrite(access: ShareAccess): boolean {
  return access === "edit" || access === "admin";
}

function fromRank(rank: unknown): ShareAccess {
  const value = Number(rank);
  return value >= 3 ? "admin" : value === 2 ? "edit" : "read";
}

function isAccess(value: unknown): value is ShareAccess {
  return value === "read" || value === "edit" || value === "admin";
}

export type ShareRow = {
  id: string;
  kind: ShareKind;
  targetId: string;
  title: string;
  visibility: "shared" | "public";
  access: ShareAccess;
  publicToken: string | null;
};

/**
 * Un documento visible a través de lo compartido. `file.url` lo muestra y
 * `file.downloadUrl` lo descarga (null si el rol no puede descargar).
 */
export type PublishedDoc = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  content: string;
  file: { name: string; mime: string; url: string; downloadUrl: string | null } | null;
  updatedBy: string;
  updatedAt: string;
  /** Vínculos manuales a otros documentos de lo compartido (para el grafo y los vínculos). */
  links?: ManualLink[];
  /**
   * Sin el texto (`content` vacío): se pide al abrirlo (`sharedDocContent`,
   * `publicDocContent`). Para el grafo y las menciones basta `wikiLinks`.
   */
  lazy?: boolean;
  /** Los `[[títulos]]` que nombra, cuando el texto no viene (`lazy`). */
  wikiLinks?: string[];
};

type FileLinks = (docId: string) => { url: string; downloadUrl: string | null };

/** Lo que manda `ShareMirror` del navegador del dueño (copia de respaldo). */
export type PublishInput = Omit<PublishedDoc, "file"> & { file: { name: string; mime: string; dataUrl?: string } | null };

export type PublishedPortfolio = { id: string; name: string; parentId: string | null };

/** Lo que ve quien abre un elemento compartido: el elemento y su contenido. */
export type SharedTree = {
  share: {
    id: string;
    kind: ShareKind;
    title: string;
    ownerName: string;
    visibility: "shared" | "public";
    access: ShareAccess;
    /** Abierto por enlace público: con él se pide el texto de cada documento. */
    token?: string;
  };
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
  access: ShareAccess;
  public_token: string | null;
};

function accessOf(item: ItemRecord): ShareAccess {
  return item.visibility === "shared" && isAccess(item.access) ? item.access : "read";
}

function toRow(item: ItemRecord): ShareRow {
  return {
    id: item.id,
    kind: item.kind,
    targetId: item.target_id,
    title: item.title,
    visibility: item.visibility,
    access: accessOf(item),
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
    select id, owner_id, kind, target_id, title, visibility, access, public_token
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
    access: ShareAccess;
    userIds: string[];
    orgIds: string[];
  },
): Promise<void> {
  const existing = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, access, public_token from share_item
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
  const access: ShareAccess = input.visibility === "shared" ? input.access : "read";
  const id = current?.id ?? randomUUID();
  if (current) {
    await sql`
      update share_item
      set title = ${input.title}, visibility = ${input.visibility}, access = ${access}, public_token = ${token},
        updated_at = now()
      where id = ${id}
    `;
  } else {
    await sql`
      insert into share_item (id, owner_id, kind, target_id, title, visibility, access, public_token)
      values (${id}, ${ownerId}, ${input.kind}, ${input.targetId}, ${input.title}, ${input.visibility}, ${access}, ${token})
    `;
  }
  // El nivel propio de cada invitado (si se le puso) se conserva.
  const userAccess = new Map(
    (await sql<{ user_id: string; access: string | null }>`select user_id, access from share_grant where share_id = ${id}`).map(
      (row) => [row.user_id, row.access],
    ),
  );
  const orgAccess = new Map(
    (await sql<{ org_id: string; access: string | null }>`select org_id, access from share_org_grant where share_id = ${id}`).map(
      (row) => [row.org_id, row.access],
    ),
  );
  await sql`delete from share_grant where share_id = ${id}`;
  await sql`delete from share_org_grant where share_id = ${id}`;
  if (input.visibility === "shared") {
    for (const orgId of new Set(input.orgIds)) {
      await sql`
        insert into share_org_grant (share_id, org_id, access)
        select ${id}, o.id, ${orgAccess.get(orgId) ?? null} from app_org o where o.id = ${orgId}
        on conflict do nothing
      `;
    }
    for (const userId of new Set(input.userIds)) {
      if (userId === ownerId) continue;
      await sql`
        insert into share_grant (share_id, user_id, access)
        select ${id}, id, ${userAccess.get(userId) ?? null} from "user" where id = ${userId}
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
  vault: { documentIds: string[]; portfolios: PublishedPortfolio[]; documents: PublishInput[] },
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
        ${document.file?.dataUrl || null}, ${document.updatedBy}, now()
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
    file: row.file_name
      ? { name: row.file_name, mime: row.file_mime ?? "application/octet-stream", url: row.file_data ?? "", downloadUrl: row.file_data }
      : null,
    updatedBy: row.updated_by,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }));
}

async function ownerName(sql: Sql, ownerId: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from "user" where id = ${ownerId} limit 1`;
  return rows[0]?.name?.trim() || "Alguien";
}

/** Un documento del índice (sin texto) como lo recibe el visor. */
function indexDocument(document: IndexDoc): PublishedDoc {
  return {
    id: document.id,
    title: document.title,
    kind: document.kind,
    portfolioId: document.portfolioId,
    content: "",
    lazy: true,
    wikiLinks: document.wikiLinks,
    file: document.file ? { ...document.file, url: "", downloadUrl: null } : null,
    updatedBy: document.updatedBy,
    updatedAt: document.updatedAt,
    links: document.links,
  };
}

/** Cada documento del índice ya empaquetado (se descarta solo cuando el documento cambia). */
const packedDocs = new WeakMap<IndexDoc, string>();

/**
 * Árboles ya armados y empaquetados, por elemento y variante (con o sin
 * descarga, o el enlace público), con la revisión de la bóveda del dueño con
 * la que se armaron: todos los que abren lo mismo reciben el mismo texto sin
 * volver a armarlo. Los enlaces firmados de los archivos valen una hora, así
 * que se guardan como mucho 10 minutos.
 *
 * En un espacio de trabajo con mucha actividad cada guardado cambia la
 * revisión; para no rehacer (ni volver a mandar) el árbol entero a cada rato,
 * se sirve el que hay durante `STALE_MS` sin mirar la revisión. El texto de
 * cada nota se pide aparte y siempre está al día; quien acaba de crear o
 * borrar algo pide el árbol con `fresh` y lo ve al momento.
 */
const TREE_TTL_MS = 10 * 60_000;
const STALE_MS = 15_000;
const MAX_TREES = 300;
type PackedEntry = { body: string; at: number; checkedAt: number; revision: number | null; gzip?: Buffer };
const packedTrees = new Map<string, PackedEntry>();

/**
 * Lo compartido, listo para el visor (ver `domain/share-pack.ts`). Los
 * archivos se sirven por `/api/files/:id` con los enlaces que da `links`:
 * firmados para quien tiene sesión, o con el token del enlace público.
 */
async function packedTree(sql: Sql, item: ItemRecord, variant: string, links: FileLinks): Promise<PackedTree> {
  const { share, entry } = await packedEntry(sql, item, variant, links, true);
  return { share, body: entry.body };
}

async function packedEntry(
  sql: Sql,
  item: ItemRecord,
  variant: string,
  links: FileLinks,
  fresh = false,
): Promise<{ share: PackedTree["share"]; entry: PackedEntry; key: string }> {
  const share = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ownerName: await ownerName(sql, item.owner_id),
    visibility: item.visibility,
    access: accessOf(item),
  };
  const key = `${item.id}:${variant}`;
  const cached = packedTrees.get(key);
  const now = Date.now();
  const alive = cached && now - cached.at < TREE_TTL_MS;
  if (alive && !fresh && now - cached.checkedAt < STALE_MS) return { share, entry: cached, key };
  const index = await vaultIndex(sql, item.owner_id);
  if (alive && index && cached.revision === index.revision) {
    cached.checkedAt = now;
    return { share, entry: cached, key };
  }
  let body: string;
  if (index) {
    const covered = coveredBy({ kind: item.kind, targetId: item.target_id }, index.portfolios, index.documents);
    const docs: string[] = [];
    for (const document of index.documents) {
      if (!covered.documentIds.has(document.id)) continue;
      // Lo común (una nota sin archivo y con todos sus vínculos dentro de lo
      // compartido) se empaqueta una vez y se reutiliza hasta que cambie: así,
      // tras cada guardado, rehacer el árbol de miles de notas es casi gratis.
      const plain = !document.file && document.links.every((link) => covered.documentIds.has(link.targetId));
      if (plain) {
        let packed = packedDocs.get(document);
        if (!packed) {
          packed = packDoc(indexDocument(document));
          packedDocs.set(document, packed);
        }
        docs.push(packed);
        continue;
      }
      const shown = indexDocument(document);
      docs.push(
        packDoc({
          ...shown,
          links: shown.links?.filter((link) => covered.documentIds.has(link.targetId)),
          file: shown.file ? { ...shown.file, ...links(document.id) } : null,
        }),
      );
    }
    body = packBodyFrom(index.portfolios.filter((portfolio) => covered.portfolioIds.has(portfolio.id)), docs);
  } else {
    // Sin bóveda en el servidor: la copia publicada (con el texto).
    const portfolios = await readPortfolios(sql, item.owner_id);
    const documents = await readDocs(sql, item.owner_id, true);
    const covered = coveredBy({ kind: item.kind, targetId: item.target_id }, portfolios, documents);
    body = packBody(
      portfolios.filter((portfolio) => covered.portfolioIds.has(portfolio.id)),
      documents
        .filter((document) => covered.documentIds.has(document.id))
        .map((document) => ({ ...document, links: document.links?.filter((link) => covered.documentIds.has(link.targetId)) })),
    );
  }
  const entry: PackedEntry = { body, at: now, checkedAt: now, revision: index?.revision ?? null };
  // Sin bóveda en el servidor (copia publicada) no hay revisión: no se guarda.
  if (index) {
    packedTrees.delete(key);
    packedTrees.set(key, entry);
    while (packedTrees.size > MAX_TREES) packedTrees.delete(packedTrees.keys().next().value!);
  }
  return { share, entry, key };
}

/**
 * El árbol para `GET /api/shared/:id/tree`: con su ETag (cambia con la
 * revisión de la bóveda y con lo que ve esta persona), para que el navegador
 * no lo vuelva a bajar si no cambió, y comprimido una sola vez por versión.
 */
export async function sharedTreeForUser(
  sql: Sql,
  userId: string,
  shareId: string,
  canDownload: boolean,
  fresh = false,
): Promise<{ share: PackedTree["share"]; body: string; etag: string; gzip: () => Buffer } | null> {
  const item = await grantedItem(sql, userId, shareId);
  if (!item) return null;
  const { share, entry, key } = await packedEntry(
    sql,
    item,
    canDownload ? "download" : "view",
    (docId) => ({
      url: signedFileUrl(docId, item.owner_id),
      downloadUrl: canDownload ? signedFileUrl(docId, item.owner_id, true) : null,
    }),
    fresh,
  );
  // Igual en todas las instancias (no depende de cuándo armó cada una el suyo):
  // la revisión, lo que ve esta persona y la ventana de 10 minutos en que se
  // armó, para que un árbol guardado en el navegador nunca tenga enlaces de
  // archivo vencidos (valen una hora).
  const window = Math.floor(entry.at / TREE_TTL_MS);
  const tag = createHash("sha1")
    .update(`${entry.revision === null ? entry.body : `${key}:${entry.revision}`}|${window}|${JSON.stringify(share)}`)
    .digest("base64url");
  return {
    share,
    body: entry.body,
    etag: `"${tag}"`,
    gzip: () => (entry.gzip ??= gzipSync(entry.body, { level: 4 })),
  };
}

/** Si el elemento incluye el documento `docId` (sin armar todo el árbol). */
async function covers(sql: Sql, item: ItemRecord, docId: string): Promise<boolean> {
  const index = await vaultIndex(sql, item.owner_id);
  if (!index) {
    const portfolios = await readPortfolios(sql, item.owner_id);
    const documents = await readDocs(sql, item.owner_id, false);
    return coveredBy({ kind: item.kind, targetId: item.target_id }, portfolios, documents).documentIds.has(docId);
  }
  const document = index.docById.get(docId);
  if (!document) return false;
  if (item.kind === "document") return item.target_id === docId;
  return document.portfolioId !== null && descendantIds(index.portfolios, item.target_id).has(document.portfolioId);
}

/**
 * El texto de un documento de lo compartido, al abrirlo (el árbol no lo trae):
 * por invitación (`userId`) o por enlace público (`token`).
 */
export async function sharedDocText(
  sql: Sql,
  access: { userId: string; shareId: string } | { token: string },
  docId: string,
): Promise<{ content: string; updatedAt: string; updatedBy: string } | null> {
  const owner =
    "token" in access
      ? await publicDocOwner(sql, access.token, docId)
      : await grantedDocOwner(sql, access.userId, access.shareId, docId);
  return owner ? docContent(sql, owner, docId) : null;
}

/** Lo que otros compartieron con `userId` (no incluye lo público por enlace). */
export async function sharedWith(
  sql: Sql,
  userId: string,
): Promise<{ id: string; kind: ShareKind; title: string; ownerName: string; access: ShareAccess; workspace: boolean }[]> {
  const rows = await sql<{ id: string; kind: ShareKind; title: string; owner_name: string; rank: unknown; workspace: unknown }>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.id, s.kind, s.title, u.name as owner_name,
      exists (select 1 from workspace w where w.owner_id = s.owner_id) as workspace,
      coalesce(
        (
          select case coalesce(g.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end
          from share_grant g where g.share_id = s.id and g.user_id = ${userId}
        ),
        (
          select max(case coalesce(x.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end)
          from (select g.access from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine)) x
        )
      ) as rank
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
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    ownerName: row.owner_name?.trim() || "Alguien",
    access: fromRank(row.rank),
    workspace: row.workspace === true || row.workspace === "t" || row.workspace === 1,
  }));
}

/** Dueño de `docId` si `userId` lo puede ver a través del elemento compartido `shareId`. */
export async function grantedDocOwner(sql: Sql, userId: string, shareId: string, docId: string): Promise<string | null> {
  const item = await grantedItem(sql, userId, shareId);
  return item && (await covers(sql, item, docId)) ? item.owner_id : null;
}

/** Dueño de `docId` si un enlace público (`token`) lo incluye. */
export async function publicDocOwner(sql: Sql, token: string, docId: string): Promise<string | null> {
  const item = await publicItem(sql, token);
  return item && (await covers(sql, item, docId)) ? item.owner_id : null;
}

/**
 * Dueño de un documento que `userId` puede editar a través de `shareId`: el
 * elemento tiene que estar compartido con él con acceso de edición y cubrir
 * ese documento.
 */
export async function editableTarget(
  sql: Sql,
  userId: string,
  shareId: string,
  docId: string,
): Promise<{ ownerId: string } | null> {
  const item = await grantedItem(sql, userId, shareId);
  if (!item || item.owner_id === userId || !canWrite(accessOf(item))) return null;
  return (await covers(sql, item, docId)) ? { ownerId: item.owner_id } : null;
}

/** El elemento, si `userId` es su dueño o fue invitado (directamente o por organización). */
async function grantedItem(sql: Sql, userId: string, shareId: string): Promise<ItemRecord | null> {
  const rows = await sql<ItemRecord>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.id, s.owner_id, s.kind, s.target_id, s.title, s.visibility, s.public_token,
      case when s.owner_id = ${userId} then 'admin' else coalesce(
        -- Lo puesto a la persona manda sobre lo de sus organizaciones.
        (select coalesce(g.access, s.access) from share_grant g where g.share_id = s.id and g.user_id = ${userId}),
        (
          select case max(case coalesce(x.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end)
            when 3 then 'admin' when 2 then 'edit' else 'read' end
          from (select g.access from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine)) x
        )
      ) end as access
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
  return rows[0] ?? null;
}

/** Un elemento público, por su enlace. Sin sesión. */
export async function openByToken(sql: Sql, token: string): Promise<PackedTree | null> {
  const item = await publicItem(sql, token);
  if (!item) return null;
  const tree = await packedTree(sql, item, "public", (docId) => {
    const url = `/api/files/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`;
    return { url, downloadUrl: `${url}&download=1` };
  });
  return { ...tree, share: { ...tree.share, token } };
}

async function publicItem(sql: Sql, token: string): Promise<ItemRecord | null> {
  const rows = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, access, public_token
    from share_item where public_token = ${token} and visibility = 'public'
    limit 1
  `;
  return rows[0] ?? null;
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
    where u.id <> ${userId} and u.id not in (select owner_id from workspace)
    order by u.name
  `;
  return rows.map((row) => ({ id: row.id, name: row.name?.trim() || "Sin nombre", loginName: row.login_name ?? "" }));
}

// ---------------------------------------------------------------------------
// Miembros de un portafolio (para su espacio y sus permisos, ver `space.ts`)

export type PortfolioMember = {
  userId: string;
  name: string;
  loginName: string;
  access: ShareAccess;
  /** El elemento compartido y si el usuario está invitado directamente en él (se le puede cambiar el nivel). */
  shareId: string;
  direct: boolean;
  /** Si llega por una organización, cuál. */
  orgName: string | null;
};


/**
 * Quién tiene acceso a un portafolio por lo compartido: los invitados (y los
 * de sus organizaciones) de los elementos que lo cubren, el mismo o uno de los
 * que lo contienen. Si alguien llega por varios, cuenta el nivel más alto.
 */
export async function portfolioMembers(sql: Sql, ownerId: string, portfolioId: string): Promise<PortfolioMember[]> {
  const lineage = await portfolioLineage(sql, ownerId, portfolioId);
  if (lineage.length === 0) return [];
  const items = (
    await sql<ItemRecord>`
      select id, owner_id, kind, target_id, title, visibility, access, public_token
      from share_item where owner_id = ${ownerId} and kind = 'portfolio' and visibility = 'shared'
    `
  ).filter((item) => lineage.includes(item.target_id));
  const byUser = new Map<string, PortfolioMember>();
  // Entre elementos distintos (este portafolio y los que lo contienen) cuenta el nivel más alto.
  const add = (member: PortfolioMember) => {
    const known = byUser.get(member.userId);
    if (!known || RANK[member.access] > RANK[known.access] || (RANK[member.access] === RANK[known.access] && member.direct && !known.direct)) {
      byUser.set(member.userId, member);
    }
  };
  for (const item of items) {
    // Dentro de un elemento, lo puesto a la persona manda sobre lo de su organización.
    const here = new Map<string, PortfolioMember>();
    const direct = await sql<{ user_id: string; name: string; login: string | null; access: string | null }>`
      select g.user_id, u.name, coalesce(m.login_name, a.login_name) as login, g.access
      from share_grant g join "user" u on u.id = g.user_id
      left join app_user_role m on m.user_id = g.user_id
      left join app_admin a on a.user_id = g.user_id
      where g.share_id = ${item.id}
    `;
    for (const row of direct) {
      here.set(row.user_id, {
        userId: row.user_id,
        name: row.name?.trim() || row.login || "",
        loginName: row.login ?? "",
        access: isAccess(row.access) ? row.access : accessOf(item),
        shareId: item.id,
        direct: true,
        orgName: null,
      });
    }
    const viaOrg = await sql<{ user_id: string; name: string; login: string | null; access: string | null; org_name: string }>`
      with recursive tree(id, root) as (
        select o.id, o.id from app_org o join share_org_grant g on g.org_id = o.id where g.share_id = ${item.id}
        union
        select c.id, t.root from app_org c join tree t on c.parent_id = t.id
      )
      select distinct mem.user_id, u.name, coalesce(r.login_name, a.login_name) as login, g.access, o.name as org_name
      from tree t
      join app_org_member mem on mem.org_id = t.id
      join share_org_grant g on g.share_id = ${item.id} and g.org_id = t.root
      join app_org o on o.id = t.root
      join "user" u on u.id = mem.user_id
      left join app_user_role r on r.user_id = mem.user_id
      left join app_admin a on a.user_id = mem.user_id
    `;
    for (const row of viaOrg) {
      if (row.user_id === ownerId) continue;
      const known = here.get(row.user_id);
      if (known?.direct) continue;
      const access = isAccess(row.access) ? row.access : accessOf(item);
      if (known && RANK[known.access] >= RANK[access]) continue;
      here.set(row.user_id, {
        userId: row.user_id,
        name: row.name?.trim() || row.login || "",
        loginName: row.login ?? "",
        access,
        shareId: item.id,
        direct: false,
        orgName: row.org_name,
      });
    }
    for (const member of here.values()) add(member);
  }
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** El nivel de `userId` en un portafolio del dueño (`null`: sin acceso por lo compartido). */
export async function portfolioAccess(sql: Sql, ownerId: string, portfolioId: string, userId: string): Promise<ShareAccess | null> {
  if (userId === ownerId) return "admin";
  const lineage = await portfolioLineage(sql, ownerId, portfolioId);
  if (lineage.length === 0) return null;
  // Solo esa persona (antes se armaba la lista de todos los miembros, con los
  // de cada organización invitada): en cada elemento manda lo puesto a ella
  // sobre lo de sus organizaciones, y entre elementos, el nivel más alto.
  const rows = await sql<{ target_id: string; rank: unknown }>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.target_id, coalesce(
      (
        select case coalesce(g.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end
        from share_grant g where g.share_id = s.id and g.user_id = ${userId}
      ),
      (
        select max(case coalesce(x.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end)
        from (select g.access from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine)) x
      )
    ) as rank
    from share_item s
    where s.owner_id = ${ownerId} and s.kind = 'portfolio' and s.visibility = 'shared'
  `;
  const best = Math.max(0, ...rows.filter((row) => lineage.includes(row.target_id)).map((row) => Number(row.rank ?? 0)));
  return best > 0 ? fromRank(best) : null;
}

/**
 * Pone el nivel de una persona en un elemento compartido. Si llegaba por su
 * organización, queda invitada directamente con ese nivel (que manda sobre el
 * de la organización, también para bajarlo).
 */
export async function setGrantAccess(sql: Sql, shareId: string, userId: string, access: ShareAccess): Promise<boolean> {
  const rows = await sql<{ user_id: string }>`
    insert into share_grant (share_id, user_id, access) values (${shareId}, ${userId}, ${access})
    on conflict (share_id, user_id) do update set access = excluded.access
    returning user_id
  `;
  return rows.length > 0;
}

/** El elemento compartido `shareId` con el nivel de `userId` (dueño: `admin`), o `null`. */
export async function shareForUser(
  sql: Sql,
  userId: string,
  shareId: string,
): Promise<{ ownerId: string; kind: ShareKind; targetId: string; access: ShareAccess } | null> {
  const item = await grantedItem(sql, userId, shareId);
  if (!item) return null;
  return { ownerId: item.owner_id, kind: item.kind, targetId: item.target_id, access: item.owner_id === userId ? "admin" : accessOf(item) };
}
