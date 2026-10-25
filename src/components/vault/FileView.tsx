import { Download } from "lucide-react";
import type { VaultFile } from "@/domain/vault/types";

function isImage(mime: string, name: string) {
  return mime.startsWith("image/") || /\.(svg|png|jpe?g|gif|webp)$/i.test(name);
}

function isPdf(mime: string, name: string) {
  return mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

export function FileView({ title, file }: { title: string; file: VaultFile }) {
  const image = isImage(file.mime, file.name);
  const pdf = isPdf(file.mime, file.name);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3 text-sm text-muted sm:px-6">
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <a
          href={file.dataUrl}
          download={file.name}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-fg hover:bg-elevated"
        >
          <Download className="size-4" />
          Descargar
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-6">
        {image ? (
          <img src={file.dataUrl} alt={title} className="mx-auto max-h-full max-w-full rounded-md border border-line" />
        ) : pdf ? (
          <iframe title={title} src={file.dataUrl} className="h-[70vh] w-full rounded-md border border-line bg-paper" />
        ) : (
          <p className="text-sm text-faint">{file.name}</p>
        )}
      </div>
    </div>
  );
}
