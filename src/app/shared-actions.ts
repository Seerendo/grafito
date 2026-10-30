import { uploadVaultFile } from "@/app/files";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { fetchSharedTree } from "@/app/shared-open";
import { addSharedFile, createSharedNote, createSharedPortfolio } from "@/server/space.functions";
import { deleteSharedDoc, deleteSharedPortfolio } from "@/server/workspace-trash.functions";
import { t } from "@/app/i18n";
import { folderPlan, ignoredUpload } from "@/domain/vault/folders";
import { emptyTableFile, TABLE_EXTENSION, TABLE_MIME } from "@/domain/vault/table";
import type { IncomingFile } from "@/components/vault/ingest-files";

/**
 * Lo que se hace dentro de un portafolio compartido conmigo con permiso de
 * edición (un espacio de trabajo, por ejemplo): desde los botones del visor y
 * desde el clic derecho del directorio. Tras cada cambio se vuelve a leer lo
 * compartido y se muestra en el visor. Devuelven el error, o `null`.
 */

async function refresh(shareId: string, docId: string | null, reveal = true): Promise<void> {
  const tree = await fetchSharedTree(shareId, true).catch(() => null);
  if (!tree) return;
  const view = useSharedView.getState();
  const same = view.tree?.share.id === shareId;
  // Una carga no abre el archivo ni cambia de pantalla si ese compartido no está abierto.
  if (!reveal) {
    if (!same) return;
    const keep = view.docId;
    if (keep && tree.documents.some((doc) => doc.id === keep)) view.openShared(tree, keep);
    else view.openSharedPortfolio(tree, view.portfolioId);
    return;
  }
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

export async function uploadToShared(
  shareId: string,
  portfolioId: string | null,
  files: FileList | File[],
  open = false,
): Promise<string | null> {
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
  if (last) await refresh(shareId, open ? last : null, open);
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

/** «Nueva tabla» en un portafolio de lo compartido (un espacio de trabajo). */
export async function newSharedTable(shareId: string, portfolioId: string | null): Promise<string | null> {
  const file = new File([emptyTableFile()], `${t("Tabla")}${TABLE_EXTENSION}`, { type: TABLE_MIME });
  return uploadToShared(shareId, portfolioId, [file], true);
}

/**
 * Sube una carpeta con sus subcarpetas. Los portafolios se crean antes de
 * refrescar el árbol: hasta entonces la ruta vive en `ids`.
 */
export async function uploadFolderToShared(
  shareId: string,
  portfolioId: string | null,
  incoming: Array<File | IncomingFile>,
): Promise<string | null> {
  const items = incoming
    .map((item) =>
      item instanceof File
        ? { file: item, relativePath: item.webkitRelativePath || item.name }
        : { file: item.file, relativePath: item.relativePath || item.file.name },
    )
    .filter((item) => !ignoredUpload(item.relativePath) && !ignoredUpload(item.file.name));
  if (items.length === 0) return null;
  const byPath = new Map<string, { file: File; relativePath: string }>();
  for (const item of items) {
    const planned = folderPlan([item.relativePath]).files[0];
    if (planned) byPath.set(planned.relativePath, item);
  }
  const plan = folderPlan([...byPath.keys()]);
  const ids = new Map<string, string | null>([["", portfolioId]]);
  const visible = () => {
    const tree = useSharedView.getState().tree;
    return tree?.share.id === shareId ? tree : null;
  };
  let folderError: string | null = null;
  for (const folder of plan.folders) {
    const slash = folder.lastIndexOf("/");
    const parentKey = slash === -1 ? "" : folder.slice(0, slash);
    if (!ids.has(parentKey)) continue;
    const parentId = ids.get(parentKey) ?? null;
    const name = slash === -1 ? folder : folder.slice(slash + 1);
    const known = visible()?.portfolios.find((portfolio) => portfolio.parentId === parentId && portfolio.name === name);
    if (known) {
      ids.set(folder, known.id);
      continue;
    }
    const result = await createSharedPortfolio({ data: { shareId, parentId, name } }).catch(() => null);
    if (!result?.ok) {
      folderError = result?.error ?? t("No se pudo crear el portafolio.");
      continue;
    }
    ids.set(folder, result.id);
  }
  let last: string | null = null;
  let error = folderError;
  for (const planned of plan.files) {
    if (planned.folder !== "" && !ids.has(planned.folder)) continue;
    const dest = planned.folder === "" ? portfolioId : (ids.get(planned.folder) ?? null);
    const item = byPath.get(planned.relativePath);
    if (!item) continue;
    try {
      const stored = await uploadVaultFile(item.file, { shareId, portfolioId: dest });
      const result = await addSharedFile({
        data: { shareId, portfolioId: dest, key: stored.key, name: item.file.name, mime: item.file.type },
      });
      if (!result.ok) {
        error = result.error;
        break;
      }
      last = result.id;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : t("No se pudo subir.");
      break;
    }
  }
  if (plan.folders.length > 0 || last) await refresh(shareId, null, false);
  return error;
}

/** Pide archivos con el selector del sistema (desde un clic) y los sube. Con `directory`, una carpeta. */
export function pickAndUpload(shareId: string, portfolioId: string | null, directory = false): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (directory) {
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }
  input.onchange = () => {
    const list = input.files;
    if (!list?.length) return;
    const run = directory
      ? uploadFolderToShared(
          shareId,
          portfolioId,
          [...list].map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })),
        )
      : uploadToShared(shareId, portfolioId, list);
    void run.then(report);
  };
  input.click();
}

/** Un error de estas acciones, en el aviso de la bóveda. */
export function report(error: string | null): void {
  if (error) useVault.getState().setDialog({ type: "upload-error", title: "No se pudo hacer", message: error });
}
