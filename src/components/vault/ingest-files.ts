import { useVault } from "@/app/vault/store";
import { MAX_UPLOAD_BYTES } from "@/domain/vault/types";

const DOC_MIME = "application/x-grafito-document";
const PORT_MIME = "application/x-grafito-portfolio";

export function isExternalFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = [...data.types];
  if (!types.includes("Files")) return false;
  if (types.includes(DOC_MIME) || types.includes(PORT_MIME)) return false;
  return true;
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("lectura"));
    reader.readAsDataURL(file);
  });
}

function isMarkdownFile(file: File) {
  return /\.(md|markdown)$/i.test(file.name) || file.type === "text/markdown";
}

export async function ingestExternalFiles(files: FileList | File[], portfolioId: string | null) {
  const list = [...files];
  if (list.length === 0) return;
  const vault = useVault.getState();
  if (portfolioId && vault.collapsed[portfolioId]) vault.toggleCollapsed(portfolioId);
  vault.setSelectedPortfolio(portfolioId);
  let error: string | null = null;
  for (const file of list) {
    if (file.size > MAX_UPLOAD_BYTES) {
      error = `«${file.name}» supera unos 700 KB. Prueba con uno más pequeño.`;
      continue;
    }
    if (isMarkdownFile(file)) {
      const text = await file.text();
      useVault.getState().importNote(file.name, text, portfolioId);
      continue;
    }
    try {
      const dataUrl = await readDataUrl(file);
      const result = useVault.getState().uploadFile(
        portfolioId,
        file.name,
        file.type || "application/octet-stream",
        dataUrl,
      );
      if (result) error = result;
    } catch {
      error = `No se pudo leer «${file.name}».`;
    }
  }
  if (error) useVault.getState().setDialog({ type: "upload-error", message: error });
}
