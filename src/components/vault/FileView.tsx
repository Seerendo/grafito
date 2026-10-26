import { Download, PenLine, X } from "lucide-react";
import { useState } from "react";
import { useFileLinks, type FileLinks } from "@/app/files";
import { isOfficeFile, useOfficeEnabled } from "@/app/office";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import type { VaultFile } from "@/domain/vault/types";
import { OfficeEditor } from "./OfficeEditor";
import { getLocale, t } from "@/app/i18n";

type Kind = "image" | "pdf" | "video" | "audio" | "other";

function kindOf(mime: string, name: string): Kind {
  if (mime.startsWith("image/") || /\.(svg|png|jpe?g|gif|webp|avif)$/i.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(name)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|ogg|wav|m4a)$/i.test(name)) return "audio";
  return "other";
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Vista de un archivo. En la bóveda propia pide sus enlaces firmados
 * (`docId`); en lo compartido llegan hechos (`links`). Los documentos de
 * Office se abren en el editor si el servidor lo tiene (`office`): `own` para
 * los propios, `shareId` para lo compartido conmigo.
 */
export function FileView({
  title,
  file,
  docId,
  links,
  shareId,
}: {
  title: string;
  file: VaultFile;
  docId: string;
  links?: FileLinks;
  shareId?: string;
}) {
  return links ? (
    <FileBody title={title} file={file} links={links} office={shareId ? { docId, shareId } : null} />
  ) : (
    <OwnFile title={title} file={file} docId={docId} />
  );
}

function OwnFile({ title, file, docId }: { title: string; file: VaultFile; docId: string }) {
  const own = useFileLinks(docId, file);
  return <FileBody title={title} file={file} links={own.links} onBroken={own.retry} office={{ docId }} />;
}

/** Tras una subida, el archivo tarda un instante en llegar al servidor: se reintenta unas veces. */
const RETRIES = 4;

function FileBody({
  title,
  file,
  links,
  onBroken,
  office,
}: {
  title: string;
  file: VaultFile;
  links: FileLinks | null;
  onBroken?: () => void;
  office: { docId: string; shareId?: string } | null;
}) {
  const kind = kindOf(file.mime, file.name);
  const [failures, setFailures] = useState(0);
  const officeEnabled = useOfficeEnabled();
  const canOpen = Boolean(office) && officeEnabled && isOfficeFile(file.name);
  const [editing, setEditing] = useState(false);
  // Lo guardado en el editor cambia el archivo en el servidor: se baja a la bóveda.
  const pull = () => {
    const owner = useVault.getState().owner;
    if (owner && !office?.shareId) void syncVault(owner);
  };
  const broken = () => {
    if (!onBroken || failures >= RETRIES) return;
    setFailures((value) => value + 1);
    window.setTimeout(onBroken, 1200);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3 text-sm text-muted sm:px-6">
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        {file.size ? <span className="shrink-0 text-xs text-faint">{formatSize(file.size)}</span> : null}
        {canOpen ? (
          <button
            type="button"
            onClick={() => {
              if (editing) pull();
              setEditing((open) => !open);
            }}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-fg hover:bg-elevated"
          >
            {editing ? <X className="size-4" /> : <PenLine className="size-4" />}
            {editing ? t("Cerrar editor") : t("Abrir en el editor")}
          </button>
        ) : null}
        {links?.downloadUrl ? (
          <a
            href={links.downloadUrl}
            download={file.name}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-fg hover:bg-elevated"
          >
            <Download className="size-4" />
            {t("Descargar")}
          </a>
        ) : null}
      </div>
      {editing && office ? (
        <OfficeEditor
          docId={office.docId}
          shareId={office.shareId}
          lang={getLocale()}
          onSaved={pull}
          onClose={() => {
            pull();
            setEditing(false);
          }}
        />
      ) : (
      <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-6">
        {!links ? (
          <p className="text-sm text-faint">{t("Cargando…")}</p>
        ) : kind === "image" ? (
          <img
            key={links.url}
            src={links.url}
            alt={title}
            onError={broken}
            className="mx-auto max-h-full max-w-full rounded-md border border-line"
          />
        ) : kind === "pdf" ? (
          <iframe key={links.url} title={title} src={links.url} className="h-[70vh] w-full rounded-md border border-line bg-paper" />
        ) : kind === "video" ? (
          <video key={links.url} src={links.url} controls onError={broken} className="mx-auto max-h-[70vh] max-w-full rounded-md" />
        ) : kind === "audio" ? (
          <audio key={links.url} src={links.url} controls onError={broken} className="w-full" />
        ) : (
          <p className="text-sm text-faint">{file.name}</p>
        )}
      </div>
      )}
    </div>
  );
}
