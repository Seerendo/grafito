import { uploadVaultFile } from "@/app/files";
import { enqueueUpload, type UploadDestination } from "@/app/upload-queue";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { t } from "@/app/i18n";
import { DRAWING_MIME, emptyDrawing } from "@/domain/vault/drawing";
import { LATEX_EXTENSION, LATEX_MIME, latexTemplate } from "@/domain/vault/latex";
import { ignoredUpload } from "@/domain/vault/folders";
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

/** Local file with its relative folder path; empty means a loose file. */
export type IncomingFile = { file: File; relativePath: string };

/** What a drop holds: its files, and every folder path in it (empty folders included). */
export type Dropped = { files: IncomingFile[]; folders: string[] };

export function asIncoming(input: File | IncomingFile): IncomingFile {
  if (input instanceof File)
    return { file: input, relativePath: input.webkitRelativePath || input.name };
  return {
    file: input.file,
    relativePath: input.relativePath || input.file.webkitRelativePath || input.file.name,
  };
}

type DroppedEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, err?: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (entries: DroppedEntry[]) => void,
      err?: (error: DOMException) => void,
    ) => void;
  };
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

async function walkEntry(entry: DroppedEntry, prefix: string, out: Dropped): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      if (!entry.file) {
        reject(new DOMException("Sin archivo"));
        return;
      }
      entry.file(resolve, reject);
    });
    out.files.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name });
    return;
  }
  if (!entry.isDirectory) return;
  const next = prefix ? `${prefix}/${entry.name}` : entry.name;
  out.folders.push(next);
  for (const child of await readDirectory(entry)) await walkEntry(child, next, out);
}

/**
 * Dropped files and folders. Filesystem entries preserve paths and empty folders lost by
 * dataTransfer.files; fall back to files when entries are unavailable.
 */
export async function readDroppedEntries(data: DataTransfer): Promise<Dropped> {
  const entries = [...data.items]
    .map((item) => {
      const read = (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null })
        .webkitGetAsEntry;
      return item.kind === "file" && read ? read.call(item) : null;
    })
    .filter((entry): entry is DroppedEntry => Boolean(entry));
  const plain = () => ({ files: [...data.files].map((file) => asIncoming(file)), folders: [] });
  if (entries.length === 0) return plain();
  const out: Dropped = { files: [], folders: [] };
  for (const entry of entries) await walkEntry(entry, "", out);
  return out.files.length > 0 || out.folders.length > 0 ? out : plain();
}

export function droppedNothing(dropped: Dropped): boolean {
  return dropped.files.length === 0 && dropped.folders.length === 0;
}

/**
 * The personal vault as an upload destination. Folders and documents are added without
 * selecting or unfolding anything; a checkpoint syncs so the server knows the new documents.
 */
export function personalDestination(portfolioId: string | null): UploadDestination {
  const owner = useVault.getState().owner;
  const label =
    useVault.getState().portfolios.find((portfolio) => portfolio.id === portfolioId)?.name ??
    t("Carpeta Personal");
  return {
    label,
    rootId: portfolioId,
    findFolder: (parentId, name) =>
      useVault
        .getState()
        .portfolios.find((portfolio) => portfolio.parentId === parentId && portfolio.name === name)
        ?.id ?? null,
    createFolder: async (parentId, name) => {
      const id = useVault.getState().createPortfolio(parentId, name, { quiet: true });
      if (!id) throw new Error("No puedes crear portafolios aquí.");
      return id;
    },
    putFile: async (file, folderId, signal) => {
      const vault = useVault.getState();
      if (isMarkdownFile(file)) {
        const text = await file.text();
        const title = file.name.replace(/\.(md|markdown)$/i, "").trim() || t("Sin título");
        const id = vault.createDocument(folderId, title, text, { open: false, quiet: true });
        if (!id) throw new Error("Tu rol no permite crear notas.");
        return;
      }
      const stored = await uploadVaultFile(file, { portfolioId: folderId }, { signal });
      const refused = useVault
        .getState()
        .uploadFile(
          folderId,
          file.name,
          file.type || "application/octet-stream",
          stored,
          false,
          true,
        );
      if (refused) throw new Error(refused);
    },
    checkpoint: async () => {
      const current = useVault.getState().owner;
      if (current && current === owner) await syncVault(current);
    },
    stillValid: () => useVault.getState().owner === owner,
  };
}

/**
 * Upload files and folders into the personal vault in the background (see upload-queue.ts).
 * Markdown becomes notes; other files upload in chunks. open uploads a single file at once and
 * opens it, for new drawings and tables.
 */
export async function ingestExternalFiles(
  files: FileList | Array<File | IncomingFile> | Dropped,
  portfolioId: string | null,
  options?: { open?: boolean },
) {
  const dropped: Dropped =
    "folders" in files && !(files instanceof FileList)
      ? files
      : { files: [...files].map((item) => asIncoming(item)), folders: [] };
  const list = dropped.files.filter(
    (item) => !ignoredUpload(item.relativePath) && !ignoredUpload(item.file.name),
  );
  if (list.length === 0 && dropped.folders.length === 0) return;
  if (options?.open) {
    await uploadAndOpen(list[0]!.file, portfolioId);
    return;
  }
  await enqueueUpload({ files: list, folders: dropped.folders }, personalDestination(portfolioId));
}

async function uploadAndOpen(file: File, portfolioId: string | null): Promise<void> {
  let error: string | null = null;
  try {
    const stored = await uploadVaultFile(file, { portfolioId });
    error = useVault
      .getState()
      .uploadFile(portfolioId, file.name, file.type || "application/octet-stream", stored, true);
  } catch (failure) {
    error =
      failure instanceof Error ? failure.message : t("No se pudo subir «{0}».", { 0: file.name });
  }
  const owner = useVault.getState().owner;
  if (!error && owner) await syncVault(owner);
  if (error) useVault.getState().setDialog({ type: "upload-error", message: error });
}

/** Create and open an empty Excalidraw drawing in portfolioId. */
export async function createDrawing(portfolioId: string | null): Promise<void> {
  const file = new File([emptyDrawing()], `${t("Dibujo")}.excalidraw`, { type: DRAWING_MIME });
  await ingestExternalFiles([file], portfolioId, { open: true });
}

/** Create and open a LaTeX document from the template; see domain/vault/latex.ts. */
export async function createLatex(portfolioId: string | null): Promise<void> {
  const name = t("Documento LaTeX");
  const file = new File([latexTemplate(name)], `${name}${LATEX_EXTENSION}`, { type: LATEX_MIME });
  await ingestExternalFiles([file], portfolioId, { open: true });
}

/** Create and open an empty data table in portfolioId; see domain/vault/table.ts. */
export async function createTable(portfolioId: string | null): Promise<void> {
  const file = new File([emptyTableFile()], `${t("Tabla")}${TABLE_EXTENSION}`, {
    type: TABLE_MIME,
  });
  await ingestExternalFiles([file], portfolioId, { open: true });
}
