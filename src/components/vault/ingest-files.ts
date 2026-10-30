import { uploadVaultFile } from "@/app/files";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { t } from "@/app/i18n";
import { DRAWING_MIME, emptyDrawing } from "@/domain/vault/drawing";
import { folderPlan, ignoredUpload } from "@/domain/vault/folders";
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

/** Un archivo del equipo, con la ruta dentro de la carpeta elegida (vacía: va suelto). */
export type IncomingFile = { file: File; relativePath: string };

export function asIncoming(input: File | IncomingFile): IncomingFile {
  if (input instanceof File) return { file: input, relativePath: input.webkitRelativePath || input.name };
  return { file: input.file, relativePath: input.relativePath || input.file.webkitRelativePath || input.file.name };
}

type DroppedEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, err?: (error: DOMException) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: DroppedEntry[]) => void, err?: (error: DOMException) => void) => void };
};

function readDirectory(entry: DroppedEntry): Promise<DroppedEntry[]> {
  const reader = entry.createReader?.();
  if (!reader) return Promise.resolve([]);
  const all: DroppedEntry[] = [];
  return new Promise((resolve, reject) => {
    const read = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          read();
        }
      }, reject);
    };
    read();
  });
}

async function walkEntry(entry: DroppedEntry, prefix: string, out: IncomingFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      if (!entry.file) {
        reject(new DOMException("Sin archivo"));
        return;
      }
      entry.file(resolve, reject);
    });
    out.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name });
    return;
  }
  if (!entry.isDirectory) return;
  const next = prefix ? `${prefix}/${entry.name}` : entry.name;
  for (const child of await readDirectory(entry)) await walkEntry(child, next, out);
}

/**
 * Archivos soltados, incluidas carpetas. `dataTransfer.files` pierde la ruta;
 * las entradas del sistema la conservan. Si no hay entradas, valen los archivos.
 */
export async function readDroppedEntries(data: DataTransfer): Promise<IncomingFile[]> {
  const entries = [...data.items]
    .map((item) => {
      const read = (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry;
      return item.kind === "file" && read ? read.call(item) : null;
    })
    .filter((entry): entry is DroppedEntry => Boolean(entry));
  if (entries.length === 0) return [...data.files].map((file) => asIncoming(file));
  const out: IncomingFile[] = [];
  for (const entry of entries) await walkEntry(entry, "", out);
  return out.length > 0 ? out : [...data.files].map((file) => asIncoming(file));
}

/**
 * Archivos que llegan desde el equipo (arrastrar o «Subir archivo»): un `.md`
 * entra como nota; el resto se sube al servidor por partes y queda como
 * documento de tipo archivo. Al final se sincroniza para que el servidor
 * conozca la nota que apunta al archivo subido.
 */
export async function ingestExternalFiles(files: FileList | Array<File | IncomingFile>, portfolioId: string | null) {
  const list = [...files].map((item) => asIncoming(item)).filter((item) => !ignoredUpload(item.relativePath) && !ignoredUpload(item.file.name));
  if (list.length === 0) return;
  const vault = useVault.getState();
  if (portfolioId && vault.collapsed[portfolioId]) vault.toggleCollapsed(portfolioId);
  vault.setSelectedPortfolio(portfolioId);
  const byPath = new Map<string, IncomingFile>();
  for (const item of list) {
    const planned = folderPlan([item.relativePath]).files[0];
    if (planned) byPath.set(planned.relativePath, item);
  }
  const plan = folderPlan([...byPath.keys()]);
  const ids = new Map<string, string | null>([["", portfolioId]]);
  let error: string | null = null;
  for (const folder of plan.folders) {
    const slash = folder.lastIndexOf("/");
    const parentKey = slash === -1 ? "" : folder.slice(0, slash);
    if (!ids.has(parentKey)) continue;
    const parentId = ids.get(parentKey) ?? null;
    const name = slash === -1 ? folder : folder.slice(slash + 1);
    const existing = useVault.getState().portfolios.find((portfolio) => portfolio.parentId === parentId && portfolio.name === name);
    if (existing) {
      ids.set(folder, existing.id);
      continue;
    }
    const created = useVault.getState().createPortfolio(parentId, name);
    if (!created) {
      error = t("No puedes crear portafolios aquí.");
      continue;
    }
    ids.set(folder, created);
  }
  let uploaded = false;
  for (const planned of plan.files) {
    if (planned.folder !== "" && !ids.has(planned.folder)) continue;
    const dest = planned.folder === "" ? portfolioId : (ids.get(planned.folder) ?? null);
    const item = byPath.get(planned.relativePath);
    if (!item) continue;
    const file = item.file;
    if (isMarkdownFile(file)) {
      const text = await file.text();
      useVault.getState().importNote(file.name, text, dest);
      continue;
    }
    try {
      const stored = await uploadVaultFile(file, { portfolioId: dest });
      const result = useVault.getState().uploadFile(dest, file.name, file.type || "application/octet-stream", stored);
      if (result) error = result;
      else uploaded = true;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : t("No se pudo subir «{0}».", { 0: file.name });
    }
  }
  useVault.getState().setSelectedPortfolio(portfolioId);
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
