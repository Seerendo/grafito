import type { Sql } from "@/lib/db";
import { ownsKey } from "./files";
import { mayWriteInPortfolio, shareForUser } from "./share";
import { subtree } from "./space";
import { workspaceByOwner } from "./workspace";

/**
 * Dónde va una subida (solo servidor): a la bóveda propia o, con `shareId`, a
 * un portafolio compartido conmigo con permiso de edición. En ese caso el
 * archivo queda bajo el dueño del portafolio (su clave `vault/<dueño>/…`) y
 * se le cuenta a quien lo sube (`uploaded_by`, ver `space.ts`).
 */

export type UploadTarget = { ownerId: string; portfolioId: string | null; shared: boolean };

export async function uploadTarget(
  sql: Sql,
  userId: string,
  input: { shareId?: string | null; portfolioId?: string | null },
): Promise<UploadTarget | string> {
  const portfolioId = input.portfolioId || null;
  if (!input.shareId) {
    // Un portafolio recién creado en el navegador puede no haber llegado aún al
    // servidor: entonces solo cuenta el tope del usuario, sin cortar la subida.
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
  if (!(await subtree(sql, share.ownerId, share.targetId)).includes(target)) return "Ese portafolio no es parte de lo compartido.";
  if (!(await mayWriteInPortfolio(sql, share, userId, target))) return "No puedes añadir nada a ese portafolio.";
  return { ownerId: share.ownerId, portfolioId: target, shared: share.ownerId !== userId };
}

/** Si `userId` puede seguir con la subida de `key` (propia, o de un portafolio compartido con él). */
export async function mayUpload(sql: Sql, userId: string, key: string, shareId: string | null): Promise<boolean> {
  if (ownsKey(userId, key)) return true;
  if (!shareId) return false;
  const share = await shareForUser(sql, userId, shareId);
  if (!share || share.kind !== "portfolio" || !ownsKey(share.ownerId, key)) return false;
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
