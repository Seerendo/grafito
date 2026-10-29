import { uploadVaultFile } from "@/app/files";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { fetchSharedTree } from "@/app/shared-open";
import { addSharedFile, createSharedNote, createSharedPortfolio } from "@/server/space.functions";
import { deleteSharedDoc, deleteSharedPortfolio } from "@/server/workspace-trash.functions";
import { t } from "@/app/i18n";

/**
 * Lo que se hace dentro de un portafolio compartido conmigo con permiso de
 * edición (un espacio de trabajo, por ejemplo): desde los botones del visor y
 * desde el clic derecho del directorio. Tras cada cambio se vuelve a leer lo
 * compartido y se muestra en el visor. Devuelven el error, o `null`.
 */

async function refresh(shareId: string, docId: string | null): Promise<void> {
  const tree = await fetchSharedTree(shareId, true).catch(() => null);
  if (!tree) return;
  const view = useSharedView.getState();
  const same = view.tree?.share.id === shareId;
  const keep = docId ?? (same ? view.docId : null);
  if (keep && tree.documents.some((doc) => doc.id === keep)) view.openShared(tree, keep);
  // Sin documento: la página que estaba abierta (o la del compartido).
  else view.openSharedPortfolio(tree, same ? view.portfolioId : null);
}

export async function newSharedNote(shareId: string, portfolioId: string | null): Promise<string | null> {
  const result = await createSharedNote({ data: { shareId, portfolioId, title: "" } }).catch(() => null);
  if (!result?.ok) return result?.error ?? t("No se pudo crear la nota.");
  await refresh(shareId, result.id);
  return null;
}

export async function newSharedPortfolio(shareId: string, parentId: string | null, name: string): Promise<string | null> {
  const result = await createSharedPortfolio({ data: { shareId, parentId, name } }).catch(() => null);
  if (!result?.ok) return result?.error ?? t("No se pudo crear el portafolio.");
  await refresh(shareId, null);
  return null;
}

export async function uploadToShared(shareId: string, portfolioId: string | null, files: FileList | File[]): Promise<string | null> {
  let last: string | null = null;
  for (const file of [...files]) {
    try {
      const stored = await uploadVaultFile(file, { shareId, portfolioId });
      const result = await addSharedFile({ data: { shareId, portfolioId, key: stored.key, name: file.name, mime: file.type } });
      if (!result.ok) return result.error;
      last = result.id;
    } catch (error) {
      return error instanceof Error ? error.message : t("No se pudo subir.");
    }
  }
  if (last) await refresh(shareId, last);
  return null;
}

export async function deleteFromShared(shareId: string, docId: string): Promise<string | null> {
  const result = await deleteSharedDoc({ data: { shareId, docId } }).catch(() => null);
  if (!result?.ok) return result?.error ?? t("No se pudo eliminar.");
  await refresh(shareId, null);
  return null;
}

/** Un portafolio con lo que contiene, a la papelera de su dueño (en un espacio de trabajo, la de sus administradores). */
export async function deletePortfolioFromShared(shareId: string, portfolioId: string): Promise<string | null> {
  const result = await deleteSharedPortfolio({ data: { shareId, portfolioId } }).catch(() => null);
  if (!result?.ok) return result?.error ?? t("No se pudo eliminar.");
  await refresh(shareId, null);
  return null;
}

/** Pide archivos con el selector del sistema (desde un clic) y los sube. */
export function pickAndUpload(shareId: string, portfolioId: string | null): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => {
    if (input.files?.length) void uploadToShared(shareId, portfolioId, input.files).then(report);
  };
  input.click();
}

/** Un error de estas acciones, en el aviso de la bóveda. */
export function report(error: string | null): void {
  if (error) useVault.getState().setDialog({ type: "upload-error", title: "No se pudo hacer", message: error });
}
