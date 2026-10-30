import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { downloadPortfolio } from "@/app/export";
import { downloadFile } from "@/app/files";
import { t } from "@/app/i18n";
import { usePermissions } from "@/app/permissions";
import { usePluginEnabled } from "@/app/plugins";
import { useVault } from "@/app/vault/store";
import { PERMISSION, deletePermission, exportPermission } from "@/domain/permissions";
import type { Document } from "@/domain/vault/types";
import { createDrawing, createTable, ingestExternalFiles } from "./ingest-files";
import { requestNotePdf } from "./NotePdf";

export type RowMenuTarget = ({ kind: "root" } | { kind: "portfolio"; id: string } | { kind: "document"; id: string }) & {
  /** Sobre una fila elegida entre varias (Ctrl o Mayús): todas las elegidas. */
  many?: string[];
};

type RowMenu = RowMenuTarget & { x: number; y: number };

/** Margen entre el menú y el borde de la ventana. */
const EDGE = 8;

function downloadDocument(document: Document) {
  if (document.kind === "file" && document.file) {
    void downloadFile(document);
    return;
  }
  const blob = new Blob([document.content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = `${document.title}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Menú contextual de la bóveda (raíz, portafolio o documento), compartido por
 * el directorio y la raíz del área de trabajo. Devuelve `openMenu` para el
 * `onContextMenu` de cada fila y el elemento a pintar.
 */
export function useRowMenu(onOpenNote: (id: string) => void, onSelect?: (target: { kind: "document" | "portfolio"; id: string }) => void) {
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTo = useRef<string | null>(null);

  const openMenu = (event: MouseEvent, target: RowMenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ ...target, x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const element = (
    <>
      <input
        ref={uploadRef}
        type="file"
        tabIndex={-1}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void ingestExternalFiles(files, uploadTo.current).then(() => onOpenNote(useVault.getState().activeId ?? ""));
        }}
      />
      {menu ? (
        <RowContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenNote={onOpenNote}
          onSelect={onSelect}
          onUpload={(portfolioId) => {
            uploadTo.current = portfolioId;
            useVault.getState().setSelectedPortfolio(portfolioId);
            setMenu(null);
            uploadRef.current?.click();
          }}
        />
      ) : null}
    </>
  );

  return { openMenu, closeMenu: () => setMenu(null), element };
}

function RowContextMenu({
  menu,
  onClose,
  onOpenNote,
  onUpload,
  onSelect,
}: {
  menu: RowMenu;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onUpload: (portfolioId: string | null) => void;
  onSelect?: (target: { kind: "document" | "portfolio"; id: string }) => void;
}) {
  const documents = useVault((state) => state.documents);
  const can = usePermissions();
  const gitOn = usePluginEnabled("git");
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: menu.x, top: menu.y, ready: false });
  const document = menu.kind === "document" ? documents.find((item) => item.id === menu.id) : null;
  const portfolioId = menu.kind === "portfolio" ? menu.id : menu.kind === "document" ? (document?.portfolioId ?? null) : null;

  // Se mide ya pintado: si no cabe hacia abajo o a la derecha, se abre hacia
  // el otro lado, y nunca se sale de la ventana.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    let left = menu.x + box.width > width - EDGE ? menu.x - box.width : menu.x;
    let top = menu.y + box.height > height - EDGE ? menu.y - box.height : menu.y;
    left = Math.max(EDGE, Math.min(left, width - box.width - EDGE));
    top = Math.max(EDGE, Math.min(top, height - box.height - EDGE));
    setPlace({ left, top, ready: true });
  }, [menu.x, menu.y]);

  const act = (run: () => void) => () => {
    onClose();
    run();
  };
  const vault = useVault.getState;
  const items: { label: string; onClick: () => void; danger?: boolean }[] = [];
  if (onSelect && (menu.kind === "document" || menu.kind === "portfolio")) {
    const target = menu.kind === "document" ? { kind: "document" as const, id: menu.id } : { kind: "portfolio" as const, id: menu.id };
    items.push({ label: t("Seleccionar"), onClick: act(() => onSelect(target)) });
  }
  if (can(PERMISSION.notesCreate)) {
    items.push({ label: t("Nueva nota"), onClick: act(() => onOpenNote(vault().createDocument(portfolioId))) });
  }
  if (can(PERMISSION.portfoliosManage)) {
    const parentId = menu.kind === "portfolio" ? menu.id : null;
    items.push({ label: t("Nuevo portafolio"), onClick: act(() => vault().setDialog({ type: "portfolio", parentId })) });
  }
  if (can(PERMISSION.filesUpload)) {
    items.push({
      label: t("Nuevo dibujo"),
      onClick: act(() => void createDrawing(portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""))),
    });
    items.push({
      label: t("Nueva tabla"),
      onClick: act(() => void createTable(portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""))),
    });
    items.push({ label: t("Subir archivo"), onClick: () => onUpload(portfolioId) });
  }
  if (menu.kind === "document" && document) {
    const id = document.id;
    if (can(PERMISSION.notesShare)) {
      items.push({ label: t("Compartir…"), onClick: act(() => vault().setDialog({ type: "share", kind: "document", id })) });
    }
    if (can(PERMISSION.notesEdit)) {
      items.push({ label: t("Renombrar"), onClick: act(() => vault().setDialog({ type: "rename-document", id })) });
    }
    if (can(PERMISSION.linksManage)) {
      items.push({ label: t("Vincular"), onClick: act(() => vault().setDialog({ type: "link", sourceId: id })) });
    }
    if (document.kind === "markdown" && can(PERMISSION.notesCreate)) {
      items.push({
        label: t("Duplicar"),
        onClick: act(() => {
          vault().duplicate(id);
          onOpenNote(vault().activeId ?? "");
        }),
      });
    }
    if (can(exportPermission(document.kind))) {
      items.push({
        label: document.kind === "file" ? t("Descargar") : t("Exportar .md"),
        onClick: act(() => downloadDocument(document)),
      });
    }
    if (document.kind === "markdown" && can(PERMISSION.notesExport)) {
      items.push({
        label: t("Descargar PDF"),
        onClick: act(() => requestNotePdf({ title: document.title, content: document.content })),
      });
    }
    if (can(deletePermission(document.kind))) {
      items.push({ label: t("Eliminar"), danger: true, onClick: act(() => vault().setDialog({ type: "delete-document", id })) });
    }
  }
  const canZip = can(PERMISSION.notesExport) || can(PERMISSION.filesDownload);
  const canGit = gitOn && can(PERMISSION.gitSync);
  if (menu.kind === "root" && canZip) {
    items.push({ label: t("Descargar todo (.zip)"), onClick: act(() => void downloadPortfolio("all")) });
  }
  if (menu.kind === "root" && canGit) {
    items.push({ label: t("Sincronizar todo con Git…"), onClick: act(() => vault().setDialog({ type: "git", portfolioId: "all" })) });
  }
  if (menu.kind === "portfolio") {
    const id = menu.id;
    if (canZip) items.push({ label: t("Descargar (.zip)"), onClick: act(() => void downloadPortfolio(id)) });
    if (canGit) items.push({ label: t("Sincronizar con Git…"), onClick: act(() => vault().setDialog({ type: "git", portfolioId: id })) });
    items.push({ label: t("Espacio y permisos…"), onClick: act(() => vault().setDialog({ type: "space", portfolioId: id })) });
    if (can(PERMISSION.notesShare)) {
      items.push({ label: t("Compartir…"), onClick: act(() => vault().setDialog({ type: "share", kind: "portfolio", id })) });
    }
    if (can(PERMISSION.portfoliosManage)) {
      items.push({ label: t("Renombrar"), onClick: act(() => vault().setDialog({ type: "rename-portfolio", id })) });
      items.push({ label: t("Eliminar"), danger: true, onClick: act(() => vault().setDialog({ type: "delete-portfolio", id })) });
    }
  }
  // Sobre una fila elegida entre varias: lo que vale para todas a la vez.
  if (menu.many && menu.many.length > 1) {
    const keys = menu.many;
    items.splice(0, items.length, {
      label: t("Eliminar {n} elementos", { n: keys.length }),
      danger: true,
      onClick: act(() => vault().setDialog({ type: "delete-many", keys })),
    });
  }
  if (items.length === 0) return null;
  // En el cuerpo de la página: dentro de un panel con `backdrop-filter` (diseño
  // Moderno) un `position: fixed` queda recortado por el panel.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-ui="popover"
      className="fixed z-50 max-h-[calc(100dvh-1rem)] w-52 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-2xl"
      style={{ left: place.left, top: place.top, visibility: place.ready ? "visible" : "hidden" }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label + (item.danger ? "-danger" : "")}
          type="button"
          role="menuitem"
          onClick={item.onClick}
          className={`flex h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-elevated ${
            item.danger ? "text-danger" : "text-fg"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    window.document.body,
  );
}
