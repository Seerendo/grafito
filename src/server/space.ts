import type { Sql } from "@/lib/db";
import { formatBytes } from "@/domain/space";
import { descendantIds } from "@/domain/vault/portfolios";
import { vaultIndex, type IndexPortfolio } from "./vault-index";
import { workspaceByOwner, workspaceOwnLimit } from "./workspace";

export { checkShares, formatBytes } from "@/domain/space";

/**
 * Count current file versions, including trash until purge, against uploader and portfolio
 * ancestors. Optional quotas apply to new uploads; do not interrupt existing Office/drawing
 * saves and risk losing work. See migration 0022.
 */

export const DEFAULT_USER_KEY = "space_default_user";

/** Personal uploader usage excludes workspace vaults, which charge workspace allocations. */
export async function userUsage(sql: Sql, userId: string): Promise<number> {
  // Use separate indexed sums for explicit uploaders and legacy ownership instead of scanning with coalesce.
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

/** Live owner portfolios from the in-memory vault index. */
async function ownerPortfolios(sql: Sql, ownerId: string): Promise<IndexPortfolio[]> {
  const index = await vaultIndex(sql, ownerId);
  if (index) return index.portfolios;
  const rows = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from vault_portfolio where user_id = ${ownerId} and not deleted
  `;
  return rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id }));
}

/** Portfolio and all descendants. */
export async function subtree(sql: Sql, ownerId: string, portfolioId: string): Promise<string[]> {
  return [...descendantIds(await ownerPortfolios(sql, ownerId), portfolioId)];
}

/** Owner portfolio lineage including portfolioId through the root. */
export async function portfolioLineage(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
): Promise<string[]> {
  const parent = new Map(
    (await ownerPortfolios(sql, ownerId)).map((row) => [row.id, row.parentId]),
  );
  const out: string[] = [];
  for (
    let id: string | null = portfolioId;
    id && parent.has(id) && !out.includes(id);
    id = parent.get(id) ?? null
  )
    out.push(id);
  return out;
}

/** Read owner-vault usage grouped by portfolio and uploader in one query. */
async function fileSums(
  sql: Sql,
  ownerId: string,
): Promise<{ uploader: string; portfolioId: string | null; bytes: number }[]> {
  const rows = await sql<{ uploader: string; portfolio_id: string | null; bytes: unknown }>`
    select coalesce(uploaded_by, user_id) as uploader, portfolio_id, coalesce(sum(file_size), 0)::bigint as bytes
    from vault_doc where user_id = ${ownerId} and kind = 'file'
    group by 1, 2
  `;
  return rows.map((row) => ({
    uploader: row.uploader,
    portfolioId: row.portfolio_id,
    bytes: Number(row.bytes),
  }));
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

/** Portfolio subtree usage, total and per uploader. */
export async function portfolioUsage(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
): Promise<{ total: number; byUser: Map<string, number> }> {
  const ids = descendantIds(await ownerPortfolios(sql, ownerId), portfolioId);
  return usageOf(await fileSums(sql, ownerId), ids);
}

export async function defaultUserLimit(sql: Sql): Promise<number | null> {
  const rows = await sql<{
    value: string;
  }>`select value from app_setting where key = ${DEFAULT_USER_KEY} limit 1`;
  const value = Number(rows[0]?.value);
  return rows[0] && Number.isFinite(value) && value >= 0 ? value : null;
}

/** User-specific or default quota; null means unlimited. */
export async function userLimit(
  sql: Sql,
  userId: string,
): Promise<{ bytes: number | null; own: boolean }> {
  const rows = await sql<{
    bytes: unknown;
  }>`select bytes from space_user where user_id = ${userId} limit 1`;
  if (rows[0]) return { bytes: Number(rows[0].bytes), own: true };
  return { bytes: await defaultUserLimit(sql), own: false };
}

export async function portfolioLimit(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
): Promise<number | null> {
  const rows = await sql<{ bytes: unknown }>`
    select bytes from space_portfolio where owner_id = ${ownerId} and portfolio_id = ${portfolioId} limit 1
  `;
  if (rows[0]) return Number(rows[0].bytes);
  // Workspace root uses its remaining allocation.
  const workspace = await workspaceByOwner(sql, ownerId);
  return workspace && workspace.root_portfolio_id === portfolioId
    ? workspaceOwnLimit(sql, ownerId)
    : null;
}

export async function memberLimits(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
): Promise<Map<string, number>> {
  const rows = await sql<{ user_id: string; bytes: unknown }>`
    select user_id, bytes from space_member where owner_id = ${ownerId} and portfolio_id = ${portfolioId}
  `;
  return new Map(rows.map((row) => [row.user_id, Number(row.bytes)]));
}

/**
 * Check whether uploaderId may add bytes to ownerId's portfolio or root; return a reason when
 * capacity is insufficient.
 */
export async function checkSpace(
  sql: Sql,
  input: { ownerId: string; portfolioId: string | null; uploaderId: string; bytes: number },
): Promise<string | null> {
  // Workspace uploads do not consume personal quotas.
  const mine = (await workspaceByOwner(sql, input.ownerId))
    ? { bytes: null }
    : await userLimit(sql, input.uploaderId);
  if (mine.bytes !== null) {
    const used = await userUsage(sql, input.uploaderId);
    if (used + input.bytes > mine.bytes) {
      return `No te queda espacio: usas ${formatBytes(used)} de ${formatBytes(mine.bytes)}.`;
    }
  }
  if (!input.portfolioId) return null;
  // Fetch all quota data at once instead of querying each ancestor separately.
  const portfolios = await ownerPortfolios(sql, input.ownerId);
  const parent = new Map(portfolios.map((row) => [row.id, row.parentId]));
  const lineage: string[] = [];
  for (
    let id: string | null = input.portfolioId;
    id && parent.has(id) && !lineage.includes(id);
    id = parent.get(id) ?? null
  ) {
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
