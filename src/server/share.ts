import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Sql } from "@/lib/db";
import {
  endOrgGrant,
  endPublicLink,
  endUserGrant,
  noteAccess,
  personName,
  readTrail,
  retireExpired,
  type AccessHit,
  type GrantPeriod,
} from "@/server/access-trace";
import { coveredBy, coveredByAll, type ShareKind, type ShareTarget } from "@/domain/share";
import { signedFileUrl } from "./file-links";
import { portfolioLineage } from "./space";
import { redisPutTree, redisTreeBody, redisTreeChecked, redisTreeState, type SharedTreeMeta } from "./redis";
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

export type ShareGrant = { id: string; grantedAt: number; expiresAt: number | null };

export type ShareRow = {
  id: string;
  kind: ShareKind;
  targetId: string;
  title: string;
  visibility: "shared" | "public";
  access: ShareAccess;
  publicToken: string | null;
  /** Caducidad común de los invitados, si todos la tienen igual. */
  grantExpiresAt: number | null;
  linkGrantedAt: number | null;
  linkExpiresAt: number | null;
  linkRevokedAt: number | null;
  grants: ShareGrant[];
  orgGrants: ShareGrant[];
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
  link_granted_at?: unknown;
  link_expires_at?: unknown;
  link_revoked_at?: unknown;
};

function accessOf(item: ItemRecord): ShareAccess {
  return item.visibility === "shared" && isAccess(item.access) ? item.access : "read";
}

function millis(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function uniformExpiry(grants: ShareGrant[]): number | null {
  if (grants.length === 0) return null;
  const first = grants[0]?.expiresAt ?? null;
  return grants.every((grant) => grant.expiresAt === first) ? first : null;
}

function toRow(
  item: ItemRecord,
  grants: ShareGrant[] = [],
  orgGrants: ShareGrant[] = [],
): ShareRow {
  return {
    id: item.id,
    kind: item.kind,
    targetId: item.target_id,
    title: item.title,
    visibility: item.visibility,
    access: accessOf(item),
    publicToken: item.public_token,
    grantExpiresAt: uniformExpiry([...grants, ...orgGrants]),
    linkGrantedAt: millis(item.link_granted_at),
    linkExpiresAt: millis(item.link_expires_at),
    linkRevokedAt: millis(item.link_revoked_at),
    grants,
    orgGrants,
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
  await retireExpired(sql);
  const items = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, access, public_token,
      link_granted_at, link_expires_at, link_revoked_at
    from share_item where owner_id = ${ownerId}
  `;
  const grants = await sql<{ share_id: string; user_id: string; granted_at: unknown; expires_at: unknown }>`
    select g.share_id, g.user_id, g.granted_at, g.expires_at from share_grant g
    join share_item s on s.id = g.share_id
    where s.owner_id = ${ownerId}
  `;
  const orgGrants = await sql<{ share_id: string; org_id: string; granted_at: unknown; expires_at: unknown }>`
    select g.share_id, g.org_id, g.granted_at, g.expires_at from share_org_grant g
    join share_item s on s.id = g.share_id
    where s.owner_id = ${ownerId}
  `;
  return items.map((item) => {
    const people = grants
      .filter((grant) => grant.share_id === item.id)
      .map((grant) => ({ id: grant.user_id, grantedAt: millis(grant.granted_at) ?? 0, expiresAt: millis(grant.expires_at) }));
    const orgs = orgGrants
      .filter((grant) => grant.share_id === item.id)
      .map((grant) => ({ id: grant.org_id, grantedAt: millis(grant.granted_at) ?? 0, expiresAt: millis(grant.expires_at) }));
    return { ...toRow(item, people, orgs), userIds: people.map((grant) => grant.id), orgIds: orgs.map((grant) => grant.id) };
  });
}

/** Cierra en el historial los permisos y el enlace que sigan abiertos. */
async function archiveShare(sql: Sql, ownerId: string, shareId: string, endedBy: string): Promise<void> {
  const users = await sql<{ user_id: string }>`select user_id from share_grant where share_id = ${shareId}`;
  for (const row of users) await endUserGrant(sql, { ownerId, shareId, userId: row.user_id, endedBy });
  const orgs = await sql<{ org_id: string }>`select org_id from share_org_grant where share_id = ${shareId}`;
  for (const row of orgs) await endOrgGrant(sql, { ownerId, shareId, orgId: row.org_id, endedBy });
  const links = await sql<{ title: string; public_token: string | null; link_granted_at: unknown; link_expires_at: unknown }>`
    select title, public_token, link_granted_at, link_expires_at from share_item where id = ${shareId} limit 1
  `;
  const link = links[0];
  if (link?.public_token) {
    await endPublicLink(sql, {
      ownerId,
      shareId,
      title: link.title,
      grantedAt: millis(link.link_granted_at),
      expiresAt: millis(link.link_expires_at),
      endedBy,
    });
  }
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
    /** Si viene, todos los invitados que se quedan pasan a caducar entonces (`null`: no caduca). */
    expiresAt?: number | null;
    /** Igual para el enlace público. */
    linkExpiresAt?: number | null;
  },
): Promise<{ shareId: string | null; addedUserIds: string[]; addedOrgIds: string[] }> {
  const endedBy = await personName(sql, ownerId);
  const now = Date.now();
  const existing = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, access, public_token,
      link_granted_at, link_expires_at, link_revoked_at
    from share_item
    where owner_id = ${ownerId} and kind = ${input.kind} and target_id = ${input.targetId}
    limit 1
  `;
  const current = existing[0];
  if (input.visibility === "private") {
    if (current) {
      await archiveShare(sql, ownerId, current.id, endedBy);
      await sql`delete from share_item where id = ${current.id}`;
    }
    await prunePublished(sql, ownerId);
    return { shareId: null, addedUserIds: [], addedOrgIds: [] };
  }
  const access: ShareAccess = input.visibility === "shared" ? input.access : "read";
  const id = current?.id ?? randomUUID();
  let token = input.visibility === "public" ? current?.public_token ?? null : null;
  let linkGranted = input.visibility === "public" ? millis(current?.link_granted_at) : null;
  let linkExpires = input.visibility === "public" ? millis(current?.link_expires_at) : null;
  let linkRevoked = input.visibility === "public" ? millis(current?.link_revoked_at) : null;
  if (input.visibility !== "public" && current?.public_token) {
    await endPublicLink(sql, {
      ownerId,
      shareId: id,
      title: current.title,
      grantedAt: millis(current.link_granted_at),
      expiresAt: millis(current.link_expires_at),
      endedBy,
    });
    token = null;
    linkGranted = null;
    linkExpires = null;
    linkRevoked = now;
  }
  if (input.visibility === "public") {
    if (!token || linkRevoked) {
      token = newPublicToken();
      linkGranted = now;
      linkRevoked = null;
    }
    if (input.linkExpiresAt !== undefined) linkExpires = input.linkExpiresAt;
  }
  if (current) {
    await sql`
      update share_item
      set title = ${input.title}, visibility = ${input.visibility}, access = ${access}, public_token = ${token},
        link_granted_at = ${linkGranted}, link_expires_at = ${linkExpires}, link_revoked_at = ${linkRevoked},
        updated_at = now()
      where id = ${id}
    `;
  } else {
    await sql`
      insert into share_item (
        id, owner_id, kind, target_id, title, visibility, access, public_token,
        link_granted_at, link_expires_at, link_revoked_at
      ) values (
        ${id}, ${ownerId}, ${input.kind}, ${input.targetId}, ${input.title}, ${input.visibility}, ${access}, ${token},
        ${linkGranted}, ${linkExpires}, ${linkRevoked}
      )
    `;
  }
  if (input.visibility !== "shared") {
    const users = await sql<{ user_id: string }>`select user_id from share_grant where share_id = ${id}`;
    for (const row of users) await endUserGrant(sql, { ownerId, shareId: id, userId: row.user_id, endedBy });
    const orgs = await sql<{ org_id: string }>`select org_id from share_org_grant where share_id = ${id}`;
    for (const row of orgs) await endOrgGrant(sql, { ownerId, shareId: id, orgId: row.org_id, endedBy });
    return { shareId: id, addedUserIds: [], addedOrgIds: [] };
  }
  const userAccess = new Map(
    (await sql<{ user_id: string; access: string | null }>`select user_id, access from share_grant where share_id = ${id}`).map((row) => [
      row.user_id,
      row.access,
    ]),
  );
  const orgAccess = new Map(
    (await sql<{ org_id: string; access: string | null }>`select org_id, access from share_org_grant where share_id = ${id}`).map((row) => [
      row.org_id,
      row.access,
    ]),
  );
  const keepUsers = new Set(input.userIds.filter((userId) => userId !== ownerId));
  const keepOrgs = new Set(input.orgIds);
  const currentUsers = await sql<{ user_id: string }>`select user_id from share_grant where share_id = ${id}`;
  for (const row of currentUsers) {
    if (!keepUsers.has(row.user_id)) await endUserGrant(sql, { ownerId, shareId: id, userId: row.user_id, endedBy });
  }
  const currentOrgs = await sql<{ org_id: string }>`select org_id from share_org_grant where share_id = ${id}`;
  for (const row of currentOrgs) {
    if (!keepOrgs.has(row.org_id)) await endOrgGrant(sql, { ownerId, shareId: id, orgId: row.org_id, endedBy });
  }
  const addedUserIds: string[] = [];
  const addedOrgIds: string[] = [];
  for (const orgId of keepOrgs) {
    const known = orgAccess.has(orgId);
    if (!known) {
      const inserted = await sql<{ org_id: string }>`
        insert into share_org_grant (share_id, org_id, access, granted_at, expires_at)
        select ${id}, o.id, null, ${now}, ${input.expiresAt ?? null} from app_org o where o.id = ${orgId}
        on conflict do nothing
        returning org_id
      `;
      if (inserted[0]) addedOrgIds.push(inserted[0].org_id);
    } else if (input.expiresAt !== undefined) {
      await sql`update share_org_grant set expires_at = ${input.expiresAt} where share_id = ${id} and org_id = ${orgId}`;
    }
  }
  for (const userId of keepUsers) {
    const known = userAccess.has(userId);
    if (!known) {
      const inserted = await sql<{ user_id: string }>`
        insert into share_grant (share_id, user_id, access, granted_at, expires_at)
        select ${id}, id, null, ${now}, ${input.expiresAt ?? null} from "user" where id = ${userId}
        on conflict do nothing
        returning user_id
      `;
      if (inserted[0]) addedUserIds.push(inserted[0].user_id);
    } else if (input.expiresAt !== undefined) {
      await sql`update share_grant set expires_at = ${input.expiresAt} where share_id = ${id} and user_id = ${userId}`;
    }
  }
  return { shareId: id, addedUserIds, addedOrgIds };
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
    if (gone) {
      await archiveShare(sql, ownerId, share.id, "");
      await sql`delete from share_item where id = ${share.id}`;
    }
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

/**
 * Una versión del árbol. Con Redis, la misma en todas las instancias (ver
 * `redisTreeState`): la arma una y las demás la toman de ahí, así que todas
 * mandan el mismo cuerpo con la misma ETag. `body` y `gzip` se sacan uno del
 * otro cuando hace falta.
 */
type PackedEntry = { revision: number | null; at: number; checkedAt: number; body?: string; gzip?: Buffer };
const packedTrees = new Map<string, PackedEntry>();

function bodyOf(entry: PackedEntry): string {
  return (entry.body ??= gunzipSync(entry.gzip!).toString("utf8"));
}

function gzipOf(entry: PackedEntry): Buffer {
  return (entry.gzip ??= gzipSync(entry.body!, { level: 4 }));
}

function keepLocal(key: string, entry: PackedEntry): void {
  packedTrees.delete(key);
  packedTrees.set(key, entry);
  while (packedTrees.size > MAX_TREES) packedTrees.delete(packedTrees.keys().next().value!);
}

/** La versión `meta` guardada en Redis (la local si ya es esa). */
async function sharedVersion(key: string, meta: SharedTreeMeta, local: PackedEntry | undefined, now: number): Promise<PackedEntry | null> {
  if (local && local.revision === meta.revision && local.at === meta.at) return local;
  const gzip = await redisTreeBody(key, meta).catch(() => null);
  if (!gzip) return null;
  const entry: PackedEntry = { revision: meta.revision, at: meta.at, checkedAt: now, gzip };
  keepLocal(key, entry);
  return entry;
}

/**
 * Lo compartido, listo para el visor (ver `domain/share-pack.ts`). Los
 * archivos se sirven por `/api/files/:id` con los enlaces que da `links`:
 * firmados para quien tiene sesión, o con el token del enlace público.
 */
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
  const now = Date.now();
  const local = packedTrees.get(key);
  const alive = (entry: { at: number } | null | undefined) => Boolean(entry && now - entry.at < TREE_TTL_MS);
  // 1. La que tiene esta instancia, comprobada hace poco.
  if (local && alive(local) && !fresh && now - local.checkedAt < STALE_MS) return { share, entry: local, key };
  // 2. La compartida, si otra instancia la comprobó hace poco.
  const state = await redisTreeState(key).catch(() => null);
  if (state?.meta && alive(state.meta) && !fresh && state.checkedAt !== null && now - state.checkedAt < STALE_MS) {
    const entry = await sharedVersion(key, state.meta, local, now);
    if (entry) {
      entry.checkedAt = state.checkedAt;
      return { share, entry, key };
    }
  }
  // 3. Si la revisión no cambió, la que hay sigue valiendo.
  const index = await vaultIndex(sql, item.owner_id);
  if (index) {
    const meta = state?.meta ?? (local ? { revision: local.revision ?? -1, at: local.at } : null);
    if (meta && alive(meta) && meta.revision === index.revision) {
      const entry = state?.meta ? await sharedVersion(key, state.meta, local, now) : local!;
      if (entry) {
        entry.checkedAt = now;
        if (state) await redisTreeChecked(key, now, TREE_TTL_MS - (now - entry.at)).catch(() => undefined);
        return { share, entry, key };
      }
    }
  }
  // 4. Armarla.
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
    keepLocal(key, entry);
    if (state) await redisPutTree(key, { revision: index.revision, at: now }, gzipOf(entry), TREE_TTL_MS).catch(() => undefined);
  }
  return { share, entry, key };
}

type TreeResponse = { share: PackedTree["share"]; body: () => string; etag: string; gzip: () => Buffer };

/**
 * Para las rutas del árbol: el cuerpo y su ETag, que es igual en todas las
 * instancias (la versión y lo que ve esta persona), para que el navegador no
 * lo vuelva a bajar si no cambió.
 */
function treeResponse(share: PackedTree["share"], entry: PackedEntry, key: string): TreeResponse {
  const version = entry.revision === null ? createHash("sha1").update(bodyOf(entry)).digest("hex") : `${key}:${entry.revision}:${entry.at}`;
  const tag = createHash("sha1").update(`${version}|${JSON.stringify(share)}`).digest("base64url");
  return { share, body: () => bodyOf(entry), etag: `"${tag}"`, gzip: () => gzipOf(entry) };
}

/** El árbol para `GET /api/shared/:id/tree` (ver `treeResponse`). */
export async function sharedTreeForUser(
  sql: Sql,
  userId: string,
  shareId: string,
  canDownload: boolean,
  fresh = false,
): Promise<TreeResponse | null> {
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
  return treeResponse(share, entry, key);
}

/** El árbol para `GET /api/public/:token/tree`: lo publicado por enlace, sin sesión. */
export async function publicTreeFor(sql: Sql, token: string, fresh = false): Promise<TreeResponse | null> {
  const item = await publicItem(sql, token);
  if (!item) return null;
  const { share, entry, key } = await packedEntry(
    sql,
    item,
    "public",
    (docId) => {
      const url = `/api/files/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`;
      return { url, downloadUrl: `${url}&download=1` };
    },
    fresh,
  );
  return treeResponse({ ...share, token }, entry, key);
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
  await retireExpired(sql);
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
          from share_grant g where g.share_id = s.id and g.user_id = ${userId} and (g.expires_at is null or g.expires_at > ${Date.now()})
        ),
        (
          select max(case coalesce(x.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end)
          from (select g.access from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine) and (g.expires_at is null or g.expires_at > ${Date.now()})) x
        )
      ) as rank
    from share_item s
    join "user" u on u.id = s.owner_id
    where s.visibility = 'shared'
      and s.owner_id <> ${userId}
      and (
        exists (select 1 from share_grant g where g.share_id = s.id and g.user_id = ${userId} and (g.expires_at is null or g.expires_at > ${Date.now()}))
        or exists (select 1 from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine) and (g.expires_at is null or g.expires_at > ${Date.now()}))
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
  await retireExpired(sql);
  const rows = await sql<ItemRecord>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.id, s.owner_id, s.kind, s.target_id, s.title, s.visibility, s.public_token,
      case when s.owner_id = ${userId} then 'admin' else coalesce(
        -- Lo puesto a la persona manda sobre lo de sus organizaciones.
        (select coalesce(g.access, s.access) from share_grant g where g.share_id = s.id and g.user_id = ${userId} and (g.expires_at is null or g.expires_at > ${Date.now()})),
        (
          select case max(case coalesce(x.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end)
            when 3 then 'admin' when 2 then 'edit' else 'read' end
          from (select g.access from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine) and (g.expires_at is null or g.expires_at > ${Date.now()})) x
        )
      ) end as access
    from share_item s
    where s.id = ${shareId}
      and (
        s.owner_id = ${userId}
        or (s.visibility = 'shared' and (
          exists (select 1 from share_grant g where g.share_id = s.id and g.user_id = ${userId} and (g.expires_at is null or g.expires_at > ${Date.now()}))
          or exists (select 1 from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine) and (g.expires_at is null or g.expires_at > ${Date.now()}))
        ))
      )
    limit 1
  `;
  const item = rows[0] ?? null;
  if (item && item.owner_id !== userId) {
    await noteAccess(sql, {
      ownerId: item.owner_id,
      shareId: item.id,
      channel: "grant",
      actorId: userId,
      actorName: "",
    }).catch(() => undefined);
  }
  return item;
}

async function publicItem(sql: Sql, token: string): Promise<ItemRecord | null> {
  await retireExpired(sql);
  const rows = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, access, public_token, link_expires_at, link_revoked_at
    from share_item
    where public_token = ${token} and visibility = 'public' and link_revoked_at is null
      and (link_expires_at is null or link_expires_at > ${Date.now()})
    limit 1
  `;
  const item = rows[0] ?? null;
  if (item) {
    await noteAccess(sql, {
      ownerId: item.owner_id,
      shareId: item.id,
      channel: "public",
      actorId: "",
      actorName: "Enlace público",
    }).catch(() => undefined);
  }
  return item;
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
  await retireExpired(sql);
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
      where g.share_id = ${item.id} and (g.expires_at is null or g.expires_at > ${Date.now()})
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
        select o.id, o.id from app_org o join share_org_grant g on g.org_id = o.id
        where g.share_id = ${item.id} and (g.expires_at is null or g.expires_at > ${Date.now()})
        union
        select c.id, t.root from app_org c join tree t on c.parent_id = t.id
      )
      select distinct mem.user_id, u.name, coalesce(r.login_name, a.login_name) as login, g.access, o.name as org_name
      from tree t
      join app_org_member mem on mem.org_id = t.id
      join share_org_grant g on g.share_id = ${item.id} and g.org_id = t.root and (g.expires_at is null or g.expires_at > ${Date.now()})
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
  await retireExpired(sql);
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
        from share_grant g where g.share_id = s.id and g.user_id = ${userId} and (g.expires_at is null or g.expires_at > ${Date.now()})
      ),
      (
        select max(case coalesce(x.access, s.access) when 'admin' then 3 when 'edit' then 2 else 1 end)
        from (select g.access from share_org_grant g where g.share_id = s.id and g.org_id in (select id from mine) and (g.expires_at is null or g.expires_at > ${Date.now()})) x
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
    insert into share_grant (share_id, user_id, access, granted_at) values (${shareId}, ${userId}, ${access}, ${Date.now()})
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

async function ownItem(sql: Sql, ownerId: string, kind: ShareKind, targetId: string): Promise<ItemRecord | null> {
  const rows = await sql<ItemRecord>`
    select id, owner_id, kind, target_id, title, visibility, access, public_token,
      link_granted_at, link_expires_at, link_revoked_at
    from share_item where owner_id = ${ownerId} and kind = ${kind} and target_id = ${targetId} limit 1
  `;
  return rows[0] ?? null;
}

/** Quita a una persona o una organización y deja el periodo en el historial. */
export async function revokeShareSubject(
  sql: Sql,
  ownerId: string,
  input: { kind: ShareKind; targetId: string; subjectKind: "user" | "org"; subjectId: string },
): Promise<boolean> {
  const item = await ownItem(sql, ownerId, input.kind, input.targetId);
  if (!item) return false;
  const endedBy = await personName(sql, ownerId);
  if (input.subjectKind === "org") return endOrgGrant(sql, { ownerId, shareId: item.id, orgId: input.subjectId, endedBy });
  return endUserGrant(sql, { ownerId, shareId: item.id, userId: input.subjectId, endedBy });
}

/** Invalida el enlace público. El que ya se copió deja de abrir. */
export async function revokeShareLink(sql: Sql, ownerId: string, input: { kind: ShareKind; targetId: string }): Promise<boolean> {
  const item = await ownItem(sql, ownerId, input.kind, input.targetId);
  if (!item?.public_token) return false;
  const endedBy = await personName(sql, ownerId);
  await endPublicLink(sql, {
    ownerId,
    shareId: item.id,
    title: item.title,
    grantedAt: millis(item.link_granted_at),
    expiresAt: millis(item.link_expires_at),
    endedBy,
  });
  await sql`
    update share_item set public_token = null, link_revoked_at = ${Date.now()} where id = ${item.id}
  `;
  return true;
}

/** Permisos vigentes, los ya cerrados y las últimas aperturas. */
export async function shareActivity(
  sql: Sql,
  ownerId: string,
  input: { kind: ShareKind; targetId: string },
): Promise<{ periods: GrantPeriod[]; events: AccessHit[] }> {
  await retireExpired(sql);
  const item = await ownItem(sql, ownerId, input.kind, input.targetId);
  if (!item) return { periods: [], events: [] };
  const trail = await readTrail(sql, ownerId, "share", item.id);
  const users = await sql<{ user_id: string; name: string; granted_at: unknown; expires_at: unknown }>`
    select g.user_id, u.name, g.granted_at, g.expires_at from share_grant g
    join "user" u on u.id = g.user_id where g.share_id = ${item.id}
  `;
  const orgs = await sql<{ org_id: string; name: string; granted_at: unknown; expires_at: unknown }>`
    select g.org_id, o.name, g.granted_at, g.expires_at from share_org_grant g
    join app_org o on o.id = g.org_id where g.share_id = ${item.id}
  `;
  const open: GrantPeriod[] = [
    ...users.map((row) => ({
      subjectKind: "user" as const,
      subjectId: row.user_id,
      subjectName: row.name?.trim() || "",
      grantedAt: millis(row.granted_at) ?? 0,
      expiresAt: millis(row.expires_at),
      endedAt: null,
      endKind: "" as const,
    })),
    ...orgs.map((row) => ({
      subjectKind: "org" as const,
      subjectId: row.org_id,
      subjectName: row.name?.trim() || "",
      grantedAt: millis(row.granted_at) ?? 0,
      expiresAt: millis(row.expires_at),
      endedAt: null,
      endKind: "" as const,
    })),
  ];
  if (item.public_token && !millis(item.link_revoked_at)) {
    open.push({
      subjectKind: "link",
      subjectId: "",
      subjectName: item.title,
      grantedAt: millis(item.link_granted_at) ?? 0,
      expiresAt: millis(item.link_expires_at),
      endedAt: null,
      endKind: "",
    });
  }
  return { periods: [...open, ...trail.periods], events: trail.events };
}
