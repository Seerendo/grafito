import type { Sql } from "@/lib/db";
import { coveredBy, linkKept } from "@/domain/share";
import type { TextAnchor } from "@/domain/vault/anchor";
import { withManualLink, withoutManualLink } from "@/domain/vault/manual-link";
import type { ManualLink } from "@/domain/vault/types";
import { editableTarget, mayReadInPortfolio, shareForUser } from "@/server/share";
import { getDoc, nextRevision } from "@/server/vault";
import { vaultIndex } from "@/server/vault-index";

/**
 * Crea o quita un vínculo manual en un documento de un espacio de trabajo (o
 * de un portafolio compartido). Se guarda en la bóveda del dueño, no en la de
 * quien lo pide. El destino tiene que estar en el mismo elemento y quien
 * vincula tiene que poder editar el origen y ver el destino.
 */

type Change = {
  userId: string;
  actor: string;
  canLink: boolean;
  shareId: string;
  docId: string;
  add?: ManualLink;
  remove?: { targetId: string; anchor?: TextAnchor };
};

export async function changeSharedLink(
  sql: Sql,
  input: Change,
): Promise<{ ok: true; links: ManualLink[] } | { ok: false; error: string }> {
  if (!input.canLink) return { ok: false, error: "Tu rol no puede vincular." };
  const editable = await editableTarget(sql, input.userId, input.shareId, input.docId);
  if (!editable) return { ok: false, error: "Ya no puedes editar este documento." };
  const share = await shareForUser(sql, input.userId, input.shareId);
  if (!share || share.ownerId !== editable.ownerId) return { ok: false, error: "Ya no puedes editar este documento." };
  const current = await getDoc(sql, editable.ownerId, input.docId);
  if (!current) return { ok: false, error: "Ya no puedes editar este documento." };
  const index = await vaultIndex(sql, editable.ownerId);
  if (!index) return { ok: false, error: "Ya no puedes editar este documento." };
  const covered = coveredBy(share, index.portfolios, index.documents);
  let links = current.links;
  if (input.add) {
    if (input.add.targetId === input.docId && input.add.target !== "portfolio") {
      return { ok: false, error: "Ese destino no está en este espacio." };
    }
    if (!linkKept(input.add, covered)) return { ok: false, error: "Ese destino no está en este espacio." };
    const portfolioId = input.add.target === "portfolio" ? input.add.targetId : index.docById.get(input.add.targetId)?.portfolioId ?? null;
    if (!(await mayReadInPortfolio(sql, { ownerId: editable.ownerId, access: share.access }, input.userId, portfolioId))) {
      return { ok: false, error: "Ese destino no está en este espacio." };
    }
    const next = withManualLink(links, input.add);
    if (next === "full") return { ok: false, error: "Hay demasiados vínculos en este documento." };
    links = next;
  } else if (input.remove) {
    links = withoutManualLink(links, input.remove);
  } else {
    return { ok: false, error: "Nada que cambiar." };
  }
  const rev = await nextRevision(sql, editable.ownerId);
  const written = await sql<{ id: string }>`
    update vault_doc
    set links_json = ${JSON.stringify(links)}, rev = ${rev}, updated_at = ${Date.now()}, updated_by = ${input.actor}
    where user_id = ${editable.ownerId} and id = ${input.docId} and not deleted
    returning id
  `;
  if (!written[0]) return { ok: false, error: "Ya no puedes editar este documento." };
  return { ok: true, links };
}
