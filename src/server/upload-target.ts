import type { Sql } from "@/lib/db";
import { ownsKey } from "./files";
import { mayWriteInPortfolio, shareForUser } from "./share";
import { subtree } from "./space";
import { workspaceByOwner } from "./workspace";

/**
 * Resolve owned or editable shared upload destinations. Shared objects use the portfolio
 * owner's key namespace while uploaded_by charges the uploader; see space.ts.
 */

export type UploadTarget = { ownerId: string; portfolioId: string | null; shared: boolean };

export async function uploadTarget(
  sql: Sql,
  userId: string,
  input: { shareId?: string | null; portfolioId?: string | null },
): Promise<UploadTarget | string> {
  const portfolioId = input.portfolioId || null;
  if (!input.shareId) {
    // A newly created local portfolio may not yet exist server-side; apply the user quota without blocking synchronization.
    const known = portfolioId
      ? await sql<{ id: string }>`
          select id from vault_portfolio where user_id = ${userId} and id = ${portfolioId} and not deleted limit 1
        `
      : [];
    return { ownerId: userId, portfolioId: known[0] ? portfolioId : null, shared: false };
  }
  const share = await shareForUser(sql, userId, input.shareId);
  if (!share || share.kind !== "portfolio") return "No puedes añadir nada a ese portafolio.";
  const target = portfolioId ?? share.targetId;
  if (!(await subtree(sql, share.ownerId, share.targetId)).includes(target))
    return "Ese portafolio no es parte de lo compartido.";
  if (!(await mayWriteInPortfolio(sql, share, userId, target)))
    return "No puedes añadir nada a ese portafolio.";
  return { ownerId: share.ownerId, portfolioId: target, shared: share.ownerId !== userId };
}

/** Claims older than this are dropped; an unfinished upload is not resumed after a day. */
const CLAIM_MS = 24 * 60 * 60 * 1000;

/** Record that userId started key through shareId for portfolioId (see mayUpload). */
export async function claimUpload(
  sql: Sql,
  input: { key: string; userId: string; shareId: string; portfolioId: string | null },
): Promise<void> {
  const now = Date.now();
  await sql`delete from upload_claim where created_at < ${now - CLAIM_MS}`;
  await sql`
    insert into upload_claim (key, user_id, share_id, portfolio_id, created_at)
    values (${input.key}, ${input.userId}, ${input.shareId}, ${input.portfolioId}, ${now})
    on conflict (key) do nothing
  `;
}

/**
 * Whether userId may continue uploading this owned or shared object key. A key in another
 * person's vault counts only when this person started it through this share; with portfolioId,
 * only for that portfolio. Any other key of the owner, an existing file included, is refused.
 */
export async function mayUpload(
  sql: Sql,
  userId: string,
  key: string,
  shareId: string | null,
  portfolioId?: string | null,
): Promise<boolean> {
  if (ownsKey(userId, key)) return true;
  if (!shareId) return false;
  const share = await shareForUser(sql, userId, shareId);
  if (!share || share.kind !== "portfolio" || !ownsKey(share.ownerId, key)) return false;
  const claim = await sql<{ portfolio_id: string | null }>`
    select portfolio_id from upload_claim
    where key = ${key} and user_id = ${userId} and share_id = ${shareId}
      and created_at >= ${Date.now() - CLAIM_MS}
    limit 1
  `;
  if (!claim[0]) return false;
  if (portfolioId !== undefined && (claim[0].portfolio_id ?? null) !== (portfolioId ?? null))
    return false;
  if (share.access === "admin" || share.access === "edit") return true;
  const workspace = await workspaceByOwner(sql, share.ownerId);
  if (!workspace) return false;
  const rows = await sql<{ user_id: string }>`
    select user_id from workspace_access
    where owner_id = ${share.ownerId} and user_id = ${userId} and access = 'edit'
    limit 1
  `;
  return rows.length > 0;
}
