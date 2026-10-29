import type { Sql } from "@/lib/db";
import { formatBytes } from "@/domain/space";
import { descendantIds } from "@/domain/vault/portfolios";
import { vaultIndex, type IndexPortfolio } from "./vault-index";
import { workspaceByOwner, workspaceOwnLimit } from "./workspace";

export { checkShares, formatBytes } from "@/domain/space";

/**
 * Espacio de archivos (solo servidor). Ver `migrations/0022_space.sql`.
 *
 * Solo cuentan los archivos: su versión actual, también en la papelera hasta
 * vaciarla. Cada archivo se le cuenta a quien lo subió (`uploaded_by`, o el
 * dueño de la bóveda si está vacío) y al portafolio donde está y a todos los
 * que lo contienen. Los topes son opcionales y se comprueban al subir un
 * archivo nuevo; guardar cambios en uno que ya existe (Office, dibujos) no se
 * corta, para no perder trabajo.
 */

export const DEFAULT_USER_KEY = "space_default_user";

/**
 * Lo que un usuario tiene subido, en cualquier bóveda menos los espacios de
 * trabajo: eso cuenta en el del espacio de trabajo, no en el personal.
 */
export async function userUsage(sql: Sql, userId: string): Promise<number> {
  // Dos sumas que usan índices (lo subido por él, y lo suyo sin `uploaded_by`)
  // en vez de `coalesce(uploaded_by, user_id)`, que recorría toda la tabla.
  const rows = await sql<{ bytes: unknown }>`
    select (
      (select coalesce(sum(file_size), 0) from vault_doc
        where kind = 'file' and uploaded_by = ${userId} and user_id not in (select owner_id from workspace))
      + (select coalesce(sum(file_size), 0) from vault_doc
        where user_id = ${userId} and kind = 'file' and uploaded_by is null)
    )::bigint as bytes
  `;
  return Number(rows[0]?.bytes ?? 0);
}

/** Los portafolios vivos del dueño (del índice en memoria, ver `vault-index.ts`). */
async function ownerPortfolios(sql: Sql, ownerId: string): Promise<IndexPortfolio[]> {
  const index = await vaultIndex(sql, ownerId);
  if (index) return index.portfolios;
  const rows = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from vault_portfolio where user_id = ${ownerId} and not deleted
  `;
  return rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id }));
}

/** El portafolio y todos sus subportafolios. */
export async function subtree(sql: Sql, ownerId: string, portfolioId: string): Promise<string[]> {
  return [...descendantIds(await ownerPortfolios(sql, ownerId), portfolioId)];
}

/** Los portafolios del dueño desde `portfolioId` hasta la raíz (él incluido). */
export async function portfolioLineage(sql: Sql, ownerId: string, portfolioId: string): Promise<string[]> {
  const parent = new Map((await ownerPortfolios(sql, ownerId)).map((row) => [row.id, row.parentId]));
  const out: string[] = [];
  for (let id: string | null = portfolioId; id && parent.has(id) && !out.includes(id); id = parent.get(id) ?? null) out.push(id);
  return out;
}

/** Lo subido en la bóveda del dueño, por portafolio y por quien lo subió (una sola lectura). */
async function fileSums(sql: Sql, ownerId: string): Promise<{ uploader: string; portfolioId: string | null; bytes: number }[]> {
  const rows = await sql<{ uploader: string; portfolio_id: string | null; bytes: unknown }>`
    select coalesce(uploaded_by, user_id) as uploader, portfolio_id, coalesce(sum(file_size), 0)::bigint as bytes
    from vault_doc where user_id = ${ownerId} and kind = 'file'
    group by 1, 2
  `;
  return rows.map((row) => ({ uploader: row.uploader, portfolioId: row.portfolio_id, bytes: Number(row.bytes) }));
}

function usageOf(
  sums: { uploader: string; portfolioId: string | null; bytes: number }[],
  ids: Set<string>,
): { total: number; byUser: Map<string, number> } {
  const byUser = new Map<string, number>();
  let total = 0;
  for (const row of sums) {
    if (!row.portfolioId || !ids.has(row.portfolioId)) continue;
    total += row.bytes;
    byUser.set(row.uploader, (byUser.get(row.uploader) ?? 0) + row.bytes);
  }
  return { total, byUser };
}

/** Lo que ocupa un portafolio (con sus subportafolios), en total y por quien subió cada archivo. */
export async function portfolioUsage(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
): Promise<{ total: number; byUser: Map<string, number> }> {
  const ids = descendantIds(await ownerPortfolios(sql, ownerId), portfolioId);
  return usageOf(await fileSums(sql, ownerId), ids);
}

export async function defaultUserLimit(sql: Sql): Promise<number | null> {
  const rows = await sql<{ value: string }>`select value from app_setting where key = ${DEFAULT_USER_KEY} limit 1`;
  const value = Number(rows[0]?.value);
  return rows[0] && Number.isFinite(value) && value >= 0 ? value : null;
}

/** El tope de un usuario: el suyo o, si no tiene, el de por defecto (`null`: sin tope). */
export async function userLimit(sql: Sql, userId: string): Promise<{ bytes: number | null; own: boolean }> {
  const rows = await sql<{ bytes: unknown }>`select bytes from space_user where user_id = ${userId} limit 1`;
  if (rows[0]) return { bytes: Number(rows[0].bytes), own: true };
  return { bytes: await defaultUserLimit(sql), own: false };
}

export async function portfolioLimit(sql: Sql, ownerId: string, portfolioId: string): Promise<number | null> {
  const rows = await sql<{ bytes: unknown }>`
    select bytes from space_portfolio where owner_id = ${ownerId} and portfolio_id = ${portfolioId} limit 1
  `;
  if (rows[0]) return Number(rows[0].bytes);
  // El portafolio raíz de un espacio de trabajo: lo que le queda a ese espacio.
  const workspace = await workspaceByOwner(sql, ownerId);
  return workspace && workspace.root_portfolio_id === portfolioId ? workspaceOwnLimit(sql, ownerId) : null;
}

export async function memberLimits(sql: Sql, ownerId: string, portfolioId: string): Promise<Map<string, number>> {
  const rows = await sql<{ user_id: string; bytes: unknown }>`
    select user_id, bytes from space_member where owner_id = ${ownerId} and portfolio_id = ${portfolioId}
  `;
  return new Map(rows.map((row) => [row.user_id, Number(row.bytes)]));
}

/**
 * Si caben `bytes` más subidos por `uploaderId` en `portfolioId` (`null`: la
 * raíz de la bóveda) del dueño `ownerId`. Devuelve el motivo si no caben.
 */
export async function checkSpace(
  sql: Sql,
  input: { ownerId: string; portfolioId: string | null; uploaderId: string; bytes: number },
): Promise<string | null> {
  // En un espacio de trabajo no cuenta el espacio personal.
  const mine = (await workspaceByOwner(sql, input.ownerId)) ? { bytes: null } : await userLimit(sql, input.uploaderId);
  if (mine.bytes !== null) {
    const used = await userUsage(sql, input.uploaderId);
    if (used + input.bytes > mine.bytes) {
      return `No te queda espacio: usas ${formatBytes(used)} de ${formatBytes(mine.bytes)}.`;
    }
  }
  if (!input.portfolioId) return null;
  // Todo de una vez (antes, varias consultas por cada nivel de portafolios).
  const portfolios = await ownerPortfolios(sql, input.ownerId);
  const parent = new Map(portfolios.map((row) => [row.id, row.parentId]));
  const lineage: string[] = [];
  for (let id: string | null = input.portfolioId; id && parent.has(id) && !lineage.includes(id); id = parent.get(id) ?? null) {
    lineage.push(id);
  }
  const limits = new Map(
    (
      await sql<{ portfolio_id: string; bytes: unknown }>`
        select portfolio_id, bytes from space_portfolio where owner_id = ${input.ownerId}
      `
    ).map((row) => [row.portfolio_id, Number(row.bytes)]),
  );
  const workspace = await workspaceByOwner(sql, input.ownerId);
  if (workspace && !limits.has(workspace.root_portfolio_id)) {
    const own = await workspaceOwnLimit(sql, input.ownerId);
    if (own !== null) limits.set(workspace.root_portfolio_id, own);
  }
  const members = new Map(
    (
      await sql<{ portfolio_id: string; bytes: unknown }>`
        select portfolio_id, bytes from space_member where owner_id = ${input.ownerId} and user_id = ${input.uploaderId}
      `
    ).map((row) => [row.portfolio_id, Number(row.bytes)]),
  );
  let sums: Awaited<ReturnType<typeof fileSums>> | null = null;
  for (const id of lineage) {
    const limit = limits.get(id) ?? null;
    const member = members.get(id) ?? null;
    if (limit === null && member === null) continue;
    sums ??= await fileSums(sql, input.ownerId);
    const usage = usageOf(sums, descendantIds(portfolios, id));
    const name = portfolios.find((row) => row.id === id)?.name ?? "";
    if (limit !== null && usage.total + input.bytes > limit) {
      return `El portafolio «${name}» está lleno: ${formatBytes(usage.total)} de ${formatBytes(limit)}.`;
    }
    const yours = usage.byUser.get(input.uploaderId) ?? 0;
    if (member !== null && yours + input.bytes > member) {
      return `Tu espacio en «${name}» no alcanza: usas ${formatBytes(yours)} de ${formatBytes(member)}.`;
    }
  }
  return null;
}


