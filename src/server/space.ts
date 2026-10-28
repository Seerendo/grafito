import type { Sql } from "@/lib/db";
import { formatBytes } from "@/domain/space";
import { portfolioLineage } from "./share";

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

/** Lo que un usuario tiene subido, en cualquier bóveda. */
export async function userUsage(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<{ bytes: unknown }>`
    select coalesce(sum(file_size), 0)::bigint as bytes from vault_doc
    where kind = 'file' and coalesce(uploaded_by, user_id) = ${userId}
  `;
  return Number(rows[0]?.bytes ?? 0);
}

/** El portafolio y todos sus subportafolios. */
export async function subtree(sql: Sql, ownerId: string, portfolioId: string): Promise<string[]> {
  const rows = await sql<{ id: string; parent_id: string | null }>`
    select id, parent_id from vault_portfolio where user_id = ${ownerId} and not deleted
  `;
  const out = [portfolioId];
  for (let index = 0; index < out.length; index += 1) {
    for (const row of rows) if (row.parent_id === out[index] && !out.includes(row.id)) out.push(row.id);
  }
  return out;
}

/** Lo que ocupa un portafolio (con sus subportafolios), en total y por quien subió cada archivo. */
export async function portfolioUsage(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
): Promise<{ total: number; byUser: Map<string, number> }> {
  const ids = await subtree(sql, ownerId, portfolioId);
  const rows = await sql<{ uploader: string; portfolio_id: string | null; bytes: unknown }>`
    select coalesce(uploaded_by, user_id) as uploader, portfolio_id, coalesce(sum(file_size), 0)::bigint as bytes
    from vault_doc where user_id = ${ownerId} and kind = 'file'
    group by 1, 2
  `;
  const byUser = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    if (!row.portfolio_id || !ids.includes(row.portfolio_id)) continue;
    const bytes = Number(row.bytes);
    total += bytes;
    byUser.set(row.uploader, (byUser.get(row.uploader) ?? 0) + bytes);
  }
  return { total, byUser };
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
  return rows[0] ? Number(rows[0].bytes) : null;
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
  const mine = await userLimit(sql, input.uploaderId);
  if (mine.bytes !== null) {
    const used = await userUsage(sql, input.uploaderId);
    if (used + input.bytes > mine.bytes) {
      return `No te queda espacio: usas ${formatBytes(used)} de ${formatBytes(mine.bytes)}.`;
    }
  }
  if (!input.portfolioId) return null;
  const lineage = await portfolioLineage(sql, input.ownerId, input.portfolioId);
  for (const id of lineage) {
    const limit = await portfolioLimit(sql, input.ownerId, id);
    const member = (await memberLimits(sql, input.ownerId, id)).get(input.uploaderId) ?? null;
    if (limit === null && member === null) continue;
    const usage = await portfolioUsage(sql, input.ownerId, id);
    const name = await portfolioName(sql, input.ownerId, id);
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

async function portfolioName(sql: Sql, ownerId: string, id: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from vault_portfolio where user_id = ${ownerId} and id = ${id} limit 1`;
  return rows[0]?.name ?? "";
}
