import { ChevronRight, ChevronsLeft, ChevronsRight, File, FileText, Folder, FolderOpen, FolderPlus, House, Pin, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { extractTags } from "@/domain/vault/links";
import { buildForest, type PortfolioNode } from "@/domain/vault/portfolios";
import type { Document } from "@/domain/vault/types";
import { downloadFile, useUploads } from "@/app/files";
import { usePermissions } from "@/app/permissions";
import { useVault } from "@/app/vault/store";
import { PERMISSION, deletePermission, exportPermission } from "@/domain/permissions";
import { ingestExternalFiles, isExternalFileDrag } from "./ingest-files";
import { requestNotePdf } from "./NotePdf";
import { SharedSection } from "./SharedSection";
import { useTrashView } from "@/app/trash-view";
import { VisibilityMark } from "./visibility";

const PAD = ["pl-1", "pl-5", "pl-9", "pl-12"] as const;
const DOC_MIME = "application/x-grafito-document";
const PORT_MIME = "application/x-grafito-portfolio";

type RowMenu =
  | { x: number; y: number; kind: "root" }
  | { x: number; y: number; kind: "portfolio"; id: string }
  | { x: number; y: number; kind: "document"; id: string };

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

export function Sidebar({
  onOpenNote,
  onInspect,
  onHome,
  onCollapse,
  onOpenShared,
  onOpenTrash,
  holdGraph,
}: {
  onOpenNote: (id: string) => void;
  onOpenShared: () => void;
  onOpenTrash: () => void;
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
  const createDocument = useVault((state) => state.createDocument);
  const duplicate = useVault((state) => state.duplicate);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTo = useRef<string | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);

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
    setMenu(null);
  };

  const openContent = (id: string) => {
    const document = documents.find((item) => item.id === id);
    if (document?.portfolioId === null) setSelectedPortfolio(null);
    setActive(id);
    onOpenNote(id);
    setMenu(null);
  };

  const openMenu = (event: MouseEvent, next: RowMenu) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(next);
  };

  const pickUpload = (portfolioId: string | null) => {
    uploadTo.current = portfolioId;
    setSelectedPortfolio(portfolioId);
    setMenu(null);
    uploadRef.current?.click();
  };

  useEffect(() => {
    if (!menu) return;
    const onPointer = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

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
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md bg-inset px-3 text-sm text-muted">
          <Search className="size-4 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filtrar"
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-faint"
          />
          {query ? (
            <button type="button" aria-label="Limpiar filtro" onClick={() => setQuery("")} className="text-faint hover:text-fg">
              <X className="size-4" />
            </button>
          ) : null}
        </label>
        {canManagePortfolios ? (
          <button
            type="button"
            aria-label="Nuevo portafolio"
            onClick={() => setDialog({ type: "portfolio", parentId: selectedId })}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted hover:text-fg"
          >
            <FolderPlus className="size-4" />
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            aria-label="Plegar el directorio"
            title="Plegar el directorio"
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
            <p className="px-3 py-8 text-center text-sm text-faint">Nada coincide.</p>
          ) : (
            <ul>
              {filtered.map((document) => (
                <li key={document.id}>
                  <DocButton
                    document={document}
                    active={document.id === activeId}
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
                  : selectedId === null && rootPicked
                    ? "bg-inset text-fg"
                    : "text-muted hover:bg-elevated hover:text-fg"
              }`}
            >
              <House className={`size-4 shrink-0 ${selectedId === null && rootPicked ? "text-accent" : "text-faint"}`} />
              <span className="truncate font-medium">{dropOver === "root" ? "Soltar en la raíz" : "Raíz"}</span>
            </button>
            <GroupedDocs
              documents={forest.loose}
              scope="root"
              activeId={activeId}
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
                activeId={activeId}
                selectedId={selectedId}
                collapsed={collapsed}
                dropOver={dropOver}
                onOpen={open}
                onOpenContent={openContent}
                onSelect={setSelectedPortfolio}
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
              <span className="truncate font-medium">Papelera</span>
            </button>
            <div className="min-h-16 flex-1" />
          </div>
        )}
      </div>

      <UploadProgress />
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
          documents={documents}
          onNewNote={(portfolioId) => {
            const id = createDocument(portfolioId);
            setMenu(null);
            onOpenNote(id);
          }}
          onNewPortfolio={(parentId) => {
            setMenu(null);
            setDialog({ type: "portfolio", parentId });
          }}
          onUpload={pickUpload}
          onRenameDocument={(id) => {
            setMenu(null);
            setDialog({ type: "rename-document", id });
          }}
          onRenamePortfolio={(id) => {
            setMenu(null);
            setDialog({ type: "rename-portfolio", id });
          }}
          onDeleteDocument={(id) => {
            setMenu(null);
            setDialog({ type: "delete-document", id });
          }}
          onDeletePortfolio={(id) => {
            setMenu(null);
            setDialog({ type: "delete-portfolio", id });
          }}
          onLink={(id) => {
            setMenu(null);
            setDialog({ type: "link", sourceId: id });
          }}
          onDuplicate={(id) => {
            duplicate(id);
            setMenu(null);
            onOpenNote(useVault.getState().activeId ?? "");
          }}
          onDownload={(id) => {
            const document = documents.find((item) => item.id === id);
            if (document) downloadDocument(document);
            setMenu(null);
          }}
          onDownloadPdf={(id) => {
            const document = documents.find((item) => item.id === id);
            if (document?.kind === "markdown") requestNotePdf({ title: document.title, content: document.content });
            setMenu(null);
          }}
          onShare={(kind, id) => {
            setMenu(null);
            setDialog({ type: "share", kind, id });
          }}
        />
      ) : null}
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
        label="Notas"
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
        label="Archivos"
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
      className={`relative flex h-9 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-sm select-none hover:cursor-grab active:cursor-grabbing ${pad} ${
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
          aria-label={isCollapsed ? `Abrir ${node.portfolio.name}` : `Cerrar ${node.portfolio.name}`}
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
          className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-sm font-medium text-fg select-none hover:cursor-grab active:cursor-grabbing"
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

function RowContextMenu({
  menu,
  documents,
  onNewNote,
  onNewPortfolio,
  onUpload,
  onRenameDocument,
  onRenamePortfolio,
  onDeleteDocument,
  onDeletePortfolio,
  onLink,
  onDuplicate,
  onDownload,
  onDownloadPdf,
  onShare,
}: {
  menu: RowMenu;
  documents: Document[];
  onNewNote: (portfolioId: string | null) => void;
  onNewPortfolio: (parentId: string | null) => void;
  onUpload: (portfolioId: string | null) => void;
  onRenameDocument: (id: string) => void;
  onRenamePortfolio: (id: string) => void;
  onDeleteDocument: (id: string) => void;
  onDeletePortfolio: (id: string) => void;
  onLink: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDownload: (id: string) => void;
  onDownloadPdf: (id: string) => void;
  onShare: (kind: "document" | "portfolio", id: string) => void;
}) {
  const document = menu.kind === "document" ? documents.find((item) => item.id === menu.id) : null;
  const portfolioId = menu.kind === "portfolio" ? menu.id : menu.kind === "document" ? (document?.portfolioId ?? null) : null;
  const can = usePermissions();
  const left = Math.min(menu.x, window.innerWidth - 220);
  const top = Math.min(menu.y, window.innerHeight - 320);
  const items: { label: string; onClick: () => void; danger?: boolean }[] = [];
  if (can(PERMISSION.notesCreate)) items.push({ label: "Nueva nota", onClick: () => onNewNote(portfolioId) });
  if (can(PERMISSION.portfoliosManage)) {
    items.push({ label: "Nuevo portafolio", onClick: () => onNewPortfolio(menu.kind === "portfolio" ? menu.id : null) });
  }
  if (can(PERMISSION.filesUpload)) items.push({ label: "Subir archivo", onClick: () => onUpload(portfolioId) });
  if (menu.kind === "document" && document) {
    if (can(PERMISSION.notesShare)) items.push({ label: "Compartir…", onClick: () => onShare("document", document.id) });
    if (can(PERMISSION.notesEdit)) items.push({ label: "Renombrar", onClick: () => onRenameDocument(document.id) });
    if (can(PERMISSION.linksManage)) items.push({ label: "Vincular", onClick: () => onLink(document.id) });
    if (document.kind === "markdown" && can(PERMISSION.notesCreate)) {
      items.push({ label: "Duplicar", onClick: () => onDuplicate(document.id) });
    }
    if (can(exportPermission(document.kind))) {
      items.push({
        label: document.kind === "file" ? "Descargar" : "Exportar .md",
        onClick: () => onDownload(document.id),
      });
    }
    if (document.kind === "markdown" && can(PERMISSION.notesExport)) {
      items.push({ label: "Descargar PDF", onClick: () => onDownloadPdf(document.id) });
    }
    if (can(deletePermission(document.kind))) {
      items.push({ label: "Eliminar", danger: true, onClick: () => onDeleteDocument(document.id) });
    }
  }
  if (menu.kind === "portfolio" && can(PERMISSION.notesShare)) {
    items.push({ label: "Compartir…", onClick: () => onShare("portfolio", menu.id) });
  }
  if (menu.kind === "portfolio" && can(PERMISSION.portfoliosManage)) {
    items.push({ label: "Renombrar", onClick: () => onRenamePortfolio(menu.id) });
    items.push({ label: "Eliminar", danger: true, onClick: () => onDeletePortfolio(menu.id) });
  }
  if (items.length === 0) return null;
  return (
    <div
      role="menu"
      className="fixed z-50 w-52 rounded-lg border border-line bg-surface p-1 shadow-2xl"
      style={{ left, top }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <MenuItem key={item.label + (item.danger ? "-danger" : "")} label={item.label} danger={item.danger} onClick={item.onClick} />
      ))}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-elevated ${
        danger ? "text-danger" : "text-fg"
      }`}
    >
      {label}
    </button>
  );
}

/** Directorio plegado: un riel estrecho con una flecha para volver a desplegarlo. */
export function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center border-r border-line bg-surface pt-2">
      <button
        type="button"
        aria-label="Desplegar el directorio"
        title="Desplegar el directorio"
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
