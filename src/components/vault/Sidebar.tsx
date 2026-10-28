import { ChevronRight, ChevronsLeft, ChevronsRight, File, FileText, Folder, FolderOpen, FolderPlus, House, Pin, Search, Trash2, X } from "lucide-react";
import { useState, type DragEvent, type MouseEvent } from "react";
import { extractTags } from "@/domain/vault/links";
import { buildForest, type PortfolioNode } from "@/domain/vault/portfolios";
import type { Document } from "@/domain/vault/types";
import { useUploads } from "@/app/files";
import { usePermissions } from "@/app/permissions";
import { useVault } from "@/app/vault/store";
import { PERMISSION } from "@/domain/permissions";
import { ingestExternalFiles, isExternalFileDrag } from "./ingest-files";
import { useRowMenu, type RowMenuTarget } from "./RowMenu";
import { SharedSection } from "./SharedSection";
import { useTrashView } from "@/app/trash-view";
import { VisibilityMark } from "./visibility";
import { t } from "@/app/i18n";

const PAD = ["pl-1", "pl-5", "pl-9", "pl-12"] as const;
const DOC_MIME = "application/x-grafito-document";
const PORT_MIME = "application/x-grafito-portfolio";

function isVaultDrag(data: DataTransfer): boolean {
  const types = [...data.types];
  return types.includes(DOC_MIME) || types.includes(PORT_MIME) || types.includes("text/plain");
}

function readDrag(data: DataTransfer): { kind: "document" | "portfolio"; id: string } | null {
  const portfolio = data.getData(PORT_MIME);
  if (portfolio) return { kind: "portfolio", id: portfolio };
  const document = data.getData(DOC_MIME);
  if (document) return { kind: "document", id: document };
  const plain = data.getData("text/plain");
  if (plain.startsWith("port:")) return { kind: "portfolio", id: plain.slice(5) };
  if (plain.startsWith("doc:")) return { kind: "document", id: plain.slice(4) };
  return null;
}

export function Sidebar({
  onOpenNote,
  onInspect,
  onHome,
  onCollapse,
  onOpenShared,
  onOpenTrash,
  onOpenPortfolio,
  holdGraph,
}: {
  onOpenNote: (id: string) => void;
  onOpenShared: () => void;
  onOpenTrash: () => void;
  /** Abre un portafolio en el centro (sus subportafolios, notas y archivos). */
  onOpenPortfolio: (id: string) => void;
  onInspect: (id: string) => void;
  onHome: () => void;
  onCollapse?: () => void;
  holdGraph: boolean;
}) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const activeId = useVault((state) => state.activeId);
  const query = useVault((state) => state.query);
  const tag = useVault((state) => state.tag);
  const selectedId = useVault((state) => state.selectedPortfolioId);
  const can = usePermissions();
  const canManagePortfolios = can(PERMISSION.portfoliosManage);
  const canUpload = can(PERMISSION.filesUpload);
  const canImport = can(PERMISSION.notesCreate);
  const rootPicked = useVault((state) => state.rootPicked);
  // Una carpeta solo se resalta si fue lo último que se eligió (ver `folderPicked`).
  const folderPicked = useVault((state) => state.folderPicked);
  const rootLit = selectedId === null && rootPicked && folderPicked;
  // Una sola fila resaltada: la carpeta si fue lo último elegido, si no el documento abierto.
  const litId = folderPicked ? null : activeId;
  const trashOpen = useTrashView((state) => state.open);
  const collapsed = useVault((state) => state.collapsed);
  const setQuery = useVault((state) => state.setQuery);
  const setTag = useVault((state) => state.setTag);
  const setActive = useVault((state) => state.setActive);
  const setSelectedPortfolio = useVault((state) => state.setSelectedPortfolio);
  const toggleCollapsed = useVault((state) => state.toggleCollapsed);
  const setDialog = useVault((state) => state.setDialog);
  const moveDocument = useVault((state) => state.moveDocument);
  const movePortfolio = useVault((state) => state.movePortfolio);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const { openMenu: showMenu, closeMenu, element: menuElement } = useRowMenu(onOpenNote);

  const filtered = documents.filter((document) => {
    if (tag && document.kind === "markdown") {
      if (!extractTags(document.content).some((item) => item.toLowerCase() === tag.toLowerCase())) return false;
    } else if (tag) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      document.title.toLowerCase().includes(needle) ||
      document.file?.name.toLowerCase().includes(needle) ||
      document.content.toLowerCase().includes(needle)
    );
  });
  const searching = query.trim().length > 0 || Boolean(tag);
  const forest = buildForest(portfolios, documents);

  const open = (id: string) => {
    const document = documents.find((item) => item.id === id);
    if (document?.portfolioId === null) setSelectedPortfolio(null);
    if (holdGraph) onInspect(id);
    else {
      setActive(id);
      onOpenNote(id);
    }
    closeMenu();
  };

  const openContent = (id: string) => {
    const document = documents.find((item) => item.id === id);
    if (document?.portfolioId === null) setSelectedPortfolio(null);
    setActive(id);
    onOpenNote(id);
    closeMenu();
  };

  const openMenu = (event: MouseEvent, next: { x: number; y: number } & RowMenuTarget) => showMenu(event, next);

  const acceptDrop = (event: DragEvent, key: string) => {
    const external = isExternalFileDrag(event.dataTransfer) && (canUpload || canImport);
    const internal = isVaultDrag(event.dataTransfer) && canManagePortfolios;
    if (!external && (searching || !internal)) return;
    if (key === "root" && (event.target as HTMLElement).closest("[data-drop-portfolio]")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = external ? "copy" : "move";
    if (dropOver !== key) setDropOver(key);
  };

  const takeExternal = (files: FileList, portfolioId: string | null) => {
    void ingestExternalFiles(files, portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""));
  };

  const takeDrop = (event: DragEvent, portfolioId: string | null) => {
    const external = isExternalFileDrag(event.dataTransfer) && (canUpload || canImport);
    const internal = isVaultDrag(event.dataTransfer) && canManagePortfolios;
    if (!external && (searching || !internal)) return;
    if (portfolioId === null && (event.target as HTMLElement).closest("[data-drop-portfolio]")) return;
    event.preventDefault();
    event.stopPropagation();
    setDropOver(null);
    if (external && event.dataTransfer.files.length > 0) {
      takeExternal(event.dataTransfer.files, portfolioId);
      return;
    }
    const payload = readDrag(event.dataTransfer);
    if (!payload) return;
    if (payload.kind === "portfolio") movePortfolio(payload.id, portfolioId);
    else moveDocument(payload.id, portfolioId);
  };

  const startDrag = (event: DragEvent, id: string) => {
    event.dataTransfer.setData(DOC_MIME, id);
    event.dataTransfer.setData("text/plain", `doc:${id}`);
    event.dataTransfer.effectAllowed = "move";
    event.stopPropagation();
  };

  const startPortfolioDrag = (event: DragEvent, id: string) => {
    event.dataTransfer.setData(PORT_MIME, id);
    event.dataTransfer.setData("text/plain", `port:${id}`);
    event.dataTransfer.effectAllowed = "move";
    event.stopPropagation();
  };

  return (
    <aside
      data-ui="sidebar"
      className="flex h-full min-h-0 w-full flex-col bg-surface md:w-72 md:border-r md:border-line"
      onDragOver={(event) => {
        if (!(canUpload || canImport) || !isExternalFileDrag(event.dataTransfer)) return;
        if ((event.target as HTMLElement).closest("[data-drop-portfolio], [data-drop-root]")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!(canUpload || canImport) || !isExternalFileDrag(event.dataTransfer)) return;
        if ((event.target as HTMLElement).closest("[data-drop-portfolio], [data-drop-root]")) return;
        event.preventDefault();
        event.stopPropagation();
        setDropOver(null);
        takeExternal(event.dataTransfer.files, selectedId);
      }}
    >
      <div className="flex items-center gap-2 px-2 pt-2">
        <label data-field className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md bg-inset px-3 text-sm text-muted">
          <Search className="size-4 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Filtrar")}
            className="min-w-0 flex-1 bg-transparent pl-1 text-fg outline-none placeholder:text-faint"
          />
          {query ? (
            <button type="button" aria-label={t("Limpiar filtro")} onClick={() => setQuery("")} className="text-faint hover:text-fg">
              <X className="size-4" />
            </button>
          ) : null}
        </label>
        {canManagePortfolios ? (
          <button
            type="button"
            aria-label={t("Nuevo portafolio")}
            onClick={() => setDialog({ type: "portfolio", parentId: selectedId })}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted hover:text-fg"
          >
            <FolderPlus className="size-4" />
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            aria-label={t("Plegar el directorio")}
            title={t("Plegar el directorio")}
            onClick={onCollapse}
            className="grid h-11 w-7 shrink-0 place-items-center rounded-md text-faint hover:text-fg"
          >
            <ChevronsLeft className="size-4" />
          </button>
        ) : null}
      </div>

      {tag ? (
        <div className="px-3 pt-2">
          <button
            type="button"
            onClick={() => setTag(null)}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-elevated px-3 text-xs text-accent"
          >
            #{tag}
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      <div
        className="mt-1 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropOver(null);
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          setSelectedPortfolio(null);
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          openMenu(event, { x: event.clientX, y: event.clientY, kind: "root" });
        }}
      >
        {searching ? (
          filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-faint">{t("Nada coincide.")}</p>
          ) : (
            <ul>
              {filtered.map((document) => (
                <li key={document.id}>
                  <DocButton
                    document={document}
                    active={document.id === litId}
                    depth={0}
                    onOpen={open}
                    onOpenContent={openContent}
                    onDragStart={startDrag}
                    onContextMenu={(event, id) =>
                      openMenu(event, { x: event.clientX, y: event.clientY, kind: "document", id })
                    }
                  />
                </li>
              ))}
            </ul>
          )
        ) : (
          <div
            data-drop-root
            className="flex min-h-full flex-col"
            onDragOver={(event) => acceptDrop(event, "root")}
            onDrop={(event) => takeDrop(event, null)}
          >
            <button
              type="button"
              onClick={onHome}
              onContextMenu={(event) => openMenu(event, { x: event.clientX, y: event.clientY, kind: "root" })}
              onDragOver={(event) => acceptDrop(event, "root")}
              onDrop={(event) => takeDrop(event, null)}
              className={`flex h-10 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm ${
                dropOver === "root"
                  ? "bg-accent/15 text-fg ring-1 ring-accent"
                  : rootLit
                    ? "bg-inset text-fg"
                    : "text-muted hover:bg-elevated hover:text-fg"
              }`}
            >
              <House className={`size-4 shrink-0 ${rootLit ? "text-accent" : "text-faint"}`} />
              <span className="truncate font-medium">{dropOver === "root" ? t("Soltar en la Carpeta Personal") : t("Carpeta Personal")}</span>
            </button>
            <GroupedDocs
              documents={forest.loose}
              scope="root"
              activeId={litId}
              depth={0}
              collapsed={collapsed}
              onOpen={open}
              onOpenContent={openContent}
              onDragStart={startDrag}
              onToggle={toggleCollapsed}
              onContextMenu={(event, id) => openMenu(event, { x: event.clientX, y: event.clientY, kind: "document", id })}
            />
            {forest.roots.map((node) => (
              <PortfolioBranch
                key={node.portfolio.id}
                node={node}
                depth={0}
                activeId={litId}
                selectedId={folderPicked ? selectedId : null}
                collapsed={collapsed}
                dropOver={dropOver}
                onOpen={open}
                onOpenContent={openContent}
                onSelect={holdGraph ? setSelectedPortfolio : onOpenPortfolio}
                onToggle={toggleCollapsed}
                onDragOver={acceptDrop}
                onDrop={takeDrop}
                onDragStart={startDrag}
                onPortfolioDragStart={startPortfolioDrag}
                onDocumentMenu={(event, id) =>
                  openMenu(event, { x: event.clientX, y: event.clientY, kind: "document", id })
                }
                onPortfolioMenu={(event, id) =>
                  openMenu(event, { x: event.clientX, y: event.clientY, kind: "portfolio", id })
                }
              />
            ))}
            <SharedSection onOpen={onOpenShared} />
            <button
              type="button"
              onClick={onOpenTrash}
              className={`mt-1 flex h-10 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm ${
                trashOpen ? "bg-inset text-fg" : "text-muted hover:bg-elevated hover:text-fg"
              }`}
            >
              <Trash2 className={`size-4 shrink-0 ${trashOpen ? "text-accent" : "text-faint"}`} />
              <span className="truncate font-medium">{t("Papelera")}</span>
            </button>
            <div className="min-h-16 flex-1" />
          </div>
        )}
      </div>

      <UploadProgress />
      {menuElement}
    </aside>
  );
}

function GroupedDocs({
  documents,
  scope,
  activeId,
  depth,
  collapsed,
  onOpen,
  onOpenContent,
  onDragStart,
  onToggle,
  onContextMenu,
}: {
  documents: Document[];
  scope: string;
  activeId: string | null;
  depth: number;
  collapsed: Record<string, boolean>;
  onOpen: (id: string) => void;
  onOpenContent: (id: string) => void;
  onDragStart: (event: DragEvent, id: string) => void;
  onToggle: (id: string) => void;
  onContextMenu: (event: MouseEvent, id: string) => void;
}) {
  const notes = documents.filter((document) => document.kind === "markdown");
  const files = documents.filter((document) => document.kind === "file");
  return (
    <>
      <KindFold
        label={t("Notas")}
        documents={notes}
        groupKey={`notes:${scope}`}
        activeId={activeId}
        depth={depth}
        collapsed={collapsed}
        onOpen={onOpen}
        onOpenContent={onOpenContent}
        onDragStart={onDragStart}
        onToggle={onToggle}
        onContextMenu={onContextMenu}
      />
      <KindFold
        label={t("Archivos")}
        documents={files}
        groupKey={`files:${scope}`}
        activeId={activeId}
        depth={depth}
        collapsed={collapsed}
        onOpen={onOpen}
        onOpenContent={onOpenContent}
        onDragStart={onDragStart}
        onToggle={onToggle}
        onContextMenu={onContextMenu}
      />
    </>
  );
}

function KindFold({
  label,
  documents,
  groupKey,
  activeId,
  depth,
  collapsed,
  onOpen,
  onOpenContent,
  onDragStart,
  onToggle,
  onContextMenu,
}: {
  label: string;
  documents: Document[];
  groupKey: string;
  activeId: string | null;
  depth: number;
  collapsed: Record<string, boolean>;
  onOpen: (id: string) => void;
  onOpenContent: (id: string) => void;
  onDragStart: (event: DragEvent, id: string) => void;
  onToggle: (id: string) => void;
  onContextMenu: (event: MouseEvent, id: string) => void;
}) {
  if (documents.length === 0) return null;
  const isCollapsed = collapsed[groupKey] ?? false;
  const pad = PAD[Math.min(depth, PAD.length - 1)];
  return (
    <div>
      <button
        type="button"
        aria-expanded={!isCollapsed}
        onClick={() => onToggle(groupKey)}
        className={`flex h-8 w-full items-center gap-1 pr-2 text-left text-[11px] font-medium tracking-widest text-faint uppercase hover:text-fg ${pad}`}
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
        <span className="truncate">{label}</span>
        <span className="ml-auto tabular-nums">{documents.length}</span>
      </button>
      {isCollapsed ? null : (
        <DocList
          documents={documents}
          activeId={activeId}
          depth={depth}
          onOpen={onOpen}
          onOpenContent={onOpenContent}
          onDragStart={onDragStart}
          onContextMenu={onContextMenu}
        />
      )}
    </div>
  );
}

function DocList({
  documents,
  activeId,
  depth,
  onOpen,
  onOpenContent,
  onDragStart,
  onContextMenu,
}: {
  documents: Document[];
  activeId: string | null;
  depth: number;
  onOpen: (id: string) => void;
  onOpenContent: (id: string) => void;
  onDragStart: (event: DragEvent, id: string) => void;
  onContextMenu: (event: MouseEvent, id: string) => void;
}) {
  return (
    <ul>
      {documents.map((document) => (
        <li key={document.id}>
          <DocButton
            document={document}
            active={document.id === activeId}
            depth={depth}
            onOpen={onOpen}
            onOpenContent={onOpenContent}
            onDragStart={onDragStart}
            onContextMenu={onContextMenu}
          />
        </li>
      ))}
    </ul>
  );
}

function DocButton({
  document,
  active,
  depth,
  onOpen,
  onOpenContent,
  onDragStart,
  onContextMenu,
}: {
  document: Document;
  active: boolean;
  depth: number;
  onOpen: (id: string) => void;
  onOpenContent: (id: string) => void;
  onDragStart: (event: DragEvent, id: string) => void;
  onContextMenu: (event: MouseEvent, id: string) => void;
}) {
  const pad = PAD[Math.min(depth, PAD.length - 1)];
  const Icon = document.kind === "file" ? File : FileText;
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => onDragStart(event, document.id)}
      onContextMenu={(event) => onContextMenu(event, document.id)}
      onClick={() => onOpen(document.id)}
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpenContent(document.id);
      }}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-9 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-sm select-none active:cursor-grabbing ${pad} ${
        active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
      }`}
    >
      {active ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
      <Icon className={`size-3.5 shrink-0 ${active ? "text-accent" : "text-faint"}`} />
      <span className="truncate">{document.title}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <VisibilityMark id={document.id} />
        {document.pinned ? <Pin className="size-3.5 shrink-0 text-accent" /> : null}
      </span>
    </button>
  );
}

function PortfolioBranch({
  node,
  depth,
  activeId,
  selectedId,
  collapsed,
  dropOver,
  onOpen,
  onOpenContent,
  onSelect,
  onToggle,
  onDragOver,
  onDrop,
  onDragStart,
  onPortfolioDragStart,
  onDocumentMenu,
  onPortfolioMenu,
}: {
  node: PortfolioNode;
  depth: number;
  activeId: string | null;
  selectedId: string | null;
  collapsed: Record<string, boolean>;
  dropOver: string | null;
  onOpen: (id: string) => void;
  onOpenContent: (id: string) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onDragOver: (event: DragEvent, key: string) => void;
  onDrop: (event: DragEvent, portfolioId: string | null) => void;
  onDragStart: (event: DragEvent, id: string) => void;
  onPortfolioDragStart: (event: DragEvent, id: string) => void;
  onDocumentMenu: (event: MouseEvent, id: string) => void;
  onPortfolioMenu: (event: MouseEvent, id: string) => void;
}) {
  const isCollapsed = collapsed[node.portfolio.id] ?? false;
  const selected = selectedId === node.portfolio.id;
  const over = dropOver === node.portfolio.id;
  const pad = PAD[Math.min(depth, PAD.length - 1)];
  const menuEvent = (event: MouseEvent) => onPortfolioMenu(event, node.portfolio.id);
  return (
    <div
      data-drop-portfolio={node.portfolio.id}
      onDragOver={(event) => onDragOver(event, node.portfolio.id)}
      onDrop={(event) => onDrop(event, node.portfolio.id)}
    >
      <div
        className={`relative flex h-9 shrink-0 items-center rounded-md ${pad} ${
          over ? "bg-accent/15 ring-1 ring-accent" : selected ? "bg-inset" : ""
        }`}
      >
        {selected ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
        <button
          type="button"
          aria-label={isCollapsed ? t("Abrir {0}", { 0: node.portfolio.name }) : t("Cerrar {0}", { 0: node.portfolio.name })}
          onClick={() => onToggle(node.portfolio.id)}
          onContextMenu={menuEvent}
          className="grid h-9 w-7 shrink-0 place-items-center text-faint hover:text-fg"
        >
          <ChevronRight className={`size-3.5 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
        </button>
        <button
          type="button"
          draggable
          onDragStart={(event) => onPortfolioDragStart(event, node.portfolio.id)}
          onClick={() => onSelect(node.portfolio.id)}
          onContextMenu={menuEvent}
          className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-1.5 text-left text-sm font-medium text-fg select-none active:cursor-grabbing"
        >
          {isCollapsed ? (
            <Folder className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-faint"}`} />
          ) : (
            <FolderOpen className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-faint"}`} />
          )}
          <span className="truncate">{node.portfolio.name}</span>
          <VisibilityMark id={node.portfolio.id} className="ml-auto mr-2" />
        </button>
      </div>
      {isCollapsed ? null : (
        <div>
          <GroupedDocs
            documents={node.documents}
            scope={node.portfolio.id}
            activeId={activeId}
            depth={depth + 1}
            collapsed={collapsed}
            onOpen={onOpen}
            onOpenContent={onOpenContent}
            onDragStart={onDragStart}
            onToggle={onToggle}
            onContextMenu={onDocumentMenu}
          />
          {node.children.map((child) => (
            <PortfolioBranch
              key={child.portfolio.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              selectedId={selectedId}
              collapsed={collapsed}
              dropOver={dropOver}
              onOpen={onOpen}
              onOpenContent={onOpenContent}
              onSelect={onSelect}
              onToggle={onToggle}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragStart={onDragStart}
              onPortfolioDragStart={onPortfolioDragStart}
              onDocumentMenu={onDocumentMenu}
              onPortfolioMenu={onPortfolioMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Directorio plegado: un riel estrecho con una flecha para volver a desplegarlo. */
export function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <div data-ui="rail" className="flex h-full w-9 shrink-0 flex-col items-center border-r border-line bg-surface pt-2">
      <button
        type="button"
        aria-label={t("Desplegar el directorio")}
        title={t("Desplegar el directorio")}
        onClick={onExpand}
        className="grid h-11 w-7 place-items-center rounded-md text-faint hover:text-fg"
      >
        <ChevronsRight className="size-4" />
      </button>
    </div>
  );
}

/** Subidas en curso, con su avance. */
function UploadProgress() {
  const uploads = useUploads((state) => state.uploads);
  if (uploads.length === 0) return null;
  return (
    <ul className="space-y-2 border-t border-line px-3 py-2" aria-live="polite">
      {uploads.map((upload) => {
        const percent = upload.total > 0 ? Math.round((upload.sent / upload.total) * 100) : 100;
        return (
          <li key={upload.id} className="text-xs text-muted">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{upload.name}</span>
              <span className="shrink-0 tabular-nums">{percent}%</span>
            </span>
            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-inset">
              <span className="block h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
