import { Download, PenLine } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useFileLinks, type FileLinks } from "@/app/files";
import { isOfficeFile, useOfficeEnabled, useOfficeReload } from "@/app/office";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import type { VaultFile } from "@/domain/vault/types";
import { OfficeEditor } from "./OfficeEditor";
import { PdfView } from "./PdfView";
import { PdfSignatures } from "./PdfSignatures";
import { DrawingView } from "./DrawingView";
import { isDrawingName } from "@/domain/vault/drawing";
import { isTableName } from "@/domain/vault/table";
import { TableView } from "./TableView";
import { usePermissions } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import type { TextAnchor } from "@/domain/vault/anchor";
import type { ManualLink } from "@/domain/vault/types";
import { getLocale, t } from "@/app/i18n";

type Kind = "image" | "pdf" | "drawing" | "video" | "audio" | "other";

function kindOf(mime: string, name: string): Kind {
  if (isDrawingName(name)) return "drawing";
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
 * los propios, `shareId` para lo compartido conmigo. En los PDF propios se
 * puede vincular una frase con otro documento, y en todos (salvo un enlace
 * público) dejarle una nota (`PdfView`).
 */
export function FileView({
  title,
  file,
  docId,
  links,
  shareId,
  onOpenNote,
  canEdit = false,
  manual,
}: {
  title: string;
  file: VaultFile;
  docId: string;
  links?: FileLinks;
  shareId?: string;
  onOpenNote?: (id: string) => void;
  /** En lo compartido: si se puede editar (dibujos). */
  canEdit?: boolean;
  /** Frases de un PDF compartido: vínculos que ya tiene y, si se puede, crear uno. */
  manual?: Omit<PdfLinking, "focus" | "onFocused">;
}) {
  const can = usePermissions();
  // Una tabla de datos: sus filas viven en el servidor, no en el archivo.
  if (isTableName(file.name)) {
    // Por enlace público no hay sesión: las tablas solo se ven dentro de Grafito.
    if (links && !shareId) {
      return <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">{t("Las tablas no se pueden ver por enlace público.")}</p>;
    }
    return (
      <TableView
        docId={docId}
        title={title}
        shareId={links ? shareId : undefined}
        canEdit={links ? canEdit && Boolean(shareId) : can(PERMISSION.notesEdit)}
        onOpenNote={onOpenNote}
      />
    );
  }
  return links ? (
    manual ? (
      <ManualFile title={title} file={file} docId={docId} fileLinks={links} shareId={shareId} canEdit={canEdit} manual={manual} />
    ) : (
      <FileBody
        title={title}
        file={file}
        links={links}
        office={shareId ? { docId, shareId } : null}
        drawing={{ docId, shareId, canEdit: canEdit && Boolean(shareId) }}
      />
    )
  ) : (
    <OwnFile title={title} file={file} docId={docId} onOpenNote={onOpenNote} />
  );
}

/** Lo que el visor de PDF necesita para vincular frases y abrir sus destinos. */
type PdfLinking = {
  links: ManualLink[];
  targetTitle: (id: string) => string | undefined;
  onLink?: (anchor: TextAnchor) => void;
  onOpen?: (id: string) => void;
  focus: TextAnchor | null;
  onFocused: () => void;
};

function OwnFile({
  title,
  file,
  docId,
  onOpenNote,
}: {
  title: string;
  file: VaultFile;
  docId: string;
  onOpenNote?: (id: string) => void;
}) {
  const own = useFileLinks(docId, file);
  const documents = useVault((state) => state.documents);
  const setDialog = useVault((state) => state.setDialog);
  const focus = useVault((state) => (state.focusAnchor?.docId === docId ? state.focusAnchor.anchor : null));
  const setFocusAnchor = useVault((state) => state.setFocusAnchor);
  const can = usePermissions();
  const onFocused = useCallback(() => setFocusAnchor(null), [setFocusAnchor]);
  const pdf: PdfLinking = {
    links: documents.find((item) => item.id === docId)?.links ?? [],
    targetTitle: (id) => documents.find((item) => item.id === id)?.title,
    onLink: can(PERMISSION.linksManage) ? (anchor) => setDialog({ type: "link", sourceId: docId, anchor }) : undefined,
    onOpen: onOpenNote,
    focus,
    onFocused,
  };
  return (
    <FileBody
      title={title}
      file={file}
      links={own.links}
      onBroken={own.retry}
      office={{ docId }}
      pdf={pdf}
      drawing={{ docId, canEdit: can(PERMISSION.notesEdit), onOpenNote }}
    />
  );
}

/** PDF de un espacio o de lo compartido: las frases vinculadas se abren y, con permiso, se crean. */
function ManualFile({
  title,
  file,
  docId,
  fileLinks,
  shareId,
  canEdit,
  manual,
}: {
  title: string;
  file: VaultFile;
  docId: string;
  fileLinks: FileLinks;
  shareId?: string;
  canEdit: boolean;
  manual: Omit<PdfLinking, "focus" | "onFocused">;
}) {
  const focus = useVault((state) => (state.focusAnchor?.docId === docId ? state.focusAnchor.anchor : null));
  const setFocusAnchor = useVault((state) => state.setFocusAnchor);
  const onFocused = useCallback(() => setFocusAnchor(null), [setFocusAnchor]);
  return (
    <FileBody
      title={title}
      file={file}
      links={fileLinks}
      office={shareId ? { docId, shareId } : null}
      pdf={{ ...manual, focus, onFocused }}
      drawing={{ docId, shareId, canEdit: canEdit && Boolean(shareId) }}
    />
  );
}

/** Tras una subida, el archivo tarda un instante en llegar al servidor: se reintenta unas veces. */
const RETRIES = 4;

function FileBody({
  title,
  file,
  links,
  onBroken,
  office,
  pdf,
  drawing,
}: {
  title: string;
  file: VaultFile;
  links: FileLinks | null;
  onBroken?: () => void;
  office: { docId: string; shareId?: string } | null;
  pdf?: PdfLinking;
  drawing: { docId: string; shareId?: string; canEdit: boolean; onOpenNote?: (id: string) => void };
}) {
  const kind = kindOf(file.mime, file.name);
  const [failures, setFailures] = useState(0);
  const officeEnabled = useOfficeEnabled();
  const canOpen = Boolean(office) && officeEnabled && isOfficeFile(file.name);
  // Un documento de Office se abre directamente en el editor al seleccionarlo.
  // Si se cierra desde el propio editor, queda un botón para volver a abrirlo.
  const [closed, setClosed] = useState(false);
  const editing = canOpen && !closed;
  const generation = useOfficeReload((state) => (office ? (state.generation[office.docId] ?? 0) : 0));
  useEffect(() => setClosed(false), [office?.docId, generation]);
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
        {canOpen && !editing ? (
          <button
            type="button"
            onClick={() => setClosed(false)}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-fg hover:bg-elevated"
          >
            <PenLine className="size-4" />
            {t("Abrir en el editor")}
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
          key={generation}
          docId={office.docId}
          shareId={office.shareId}
          lang={getLocale()}
          onSaved={pull}
          onClose={() => {
            pull();
            setClosed(true);
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
        ) : kind === "drawing" ? (
          <DrawingView
            docId={drawing.docId}
            shareId={drawing.shareId}
            canEdit={drawing.canEdit}
            onSaved={pull}
            onOpenNote={drawing.onOpenNote}
          />
        ) : kind === "pdf" ? (
          office ? (
            <PdfSignatures
              key={links.url}
              url={links.url}
              title={title}
              {...pdf}
              notes={{ docId: office.docId, shareId: office.shareId }}
            />
          ) : (
            <PdfView
              key={links.url}
              url={links.url}
              title={title}
              {...pdf}
            />
          )
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
