import { uploadVaultFile } from "@/app/files";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { t } from "@/app/i18n";
import { DRAWING_MIME, emptyDrawing } from "@/domain/vault/drawing";
import { emptyTableFile, TABLE_EXTENSION, TABLE_MIME } from "@/domain/vault/table";

const DOC_MIME = "application/x-grafito-document";
const PORT_MIME = "application/x-grafito-portfolio";

export function isExternalFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = [...data.types];
  if (!types.includes("Files")) return false;
  if (types.includes(DOC_MIME) || types.includes(PORT_MIME)) return false;
  return true;
}

function isMarkdownFile(file: File) {
  return /\.(md|markdown)$/i.test(file.name) || file.type === "text/markdown";
}

/**
 * Archivos que llegan desde el equipo (arrastrar o «Subir archivo»): un `.md`
 * entra como nota; el resto se sube al servidor por partes y queda como
 * documento de tipo archivo. Al final se sincroniza para que el servidor
 * conozca la nota que apunta al archivo subido.
 */
export async function ingestExternalFiles(files: FileList | File[], portfolioId: string | null) {
  const list = [...files];
  if (list.length === 0) return;
  const vault = useVault.getState();
  if (portfolioId && vault.collapsed[portfolioId]) vault.toggleCollapsed(portfolioId);
  vault.setSelectedPortfolio(portfolioId);
  let error: string | null = null;
  let uploaded = false;
  for (const file of list) {
    if (isMarkdownFile(file)) {
      const text = await file.text();
      useVault.getState().importNote(file.name, text, portfolioId);
      continue;
    }
    try {
      const stored = await uploadVaultFile(file, { portfolioId });
      const result = useVault.getState().uploadFile(portfolioId, file.name, file.type || "application/octet-stream", stored);
      if (result) error = result;
      else uploaded = true;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : t("No se pudo subir «{0}».", { 0: file.name });
    }
  }
  const owner = useVault.getState().owner;
  if (uploaded && owner) await syncVault(owner);
  if (error) useVault.getState().setDialog({ type: "upload-error", message: error });
}

/** «Nuevo dibujo»: un dibujo de Excalidraw vacío en `portfolioId`, que queda abierto. */
export async function createDrawing(portfolioId: string | null): Promise<void> {
  const file = new File([emptyDrawing()], `${t("Dibujo")}.excalidraw`, { type: DRAWING_MIME });
  await ingestExternalFiles([file], portfolioId);
}

/** «Nueva tabla»: una tabla de datos vacía en `portfolioId`, que queda abierta (ver `domain/vault/table.ts`). */
export async function createTable(portfolioId: string | null): Promise<void> {
  const file = new File([emptyTableFile()], `${t("Tabla")}${TABLE_EXTENSION}`, { type: TABLE_MIME });
  await ingestExternalFiles([file], portfolioId);
}
