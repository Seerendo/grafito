import {
  FileText,
  Folder,
  Link2,
  Network,
  Plus,
  Search,
} from "lucide-react";
import { clearStrayCaret, releaseFocus } from "@/app/blank-click";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { Modal } from "@/components/ui/Modal";
import { AccountMenu } from "@/components/chrome/ChromeHeader";
import { listPlugins } from "@/server/admin.functions";
import { pluginFlagsFresh, setPluginFlags } from "@/app/plugins";
import { useCan } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { TableIndexSync } from "./TableIndexSync";
import { VaultMirror } from "./VaultMirror";
import { VaultSync } from "./VaultSync";
import { AiChat } from "@/components/ai/AiChat";
import { useAiChat } from "@/app/ai-chat";
import { useSharedView } from "@/app/shared-view";
import { useTrashView } from "@/app/trash-view";
import { SharedViewer } from "@/components/share/SharedViewer";
import { asDocuments, canEditSharedPortfolio, orderDocuments, rootParent } from "@/components/share/shared-tree";
import { SignatureDialog } from "./SignatureDialog";
import { TrashBoard } from "./TrashBoard";
import { ShareDialog } from "./ShareDialog";
import { GitDialog } from "./GitDialog";
import { SpaceDialog } from "./SpaceDialog";
import { commitSharedLink, sharedCandidates, useSharedLinkCheck } from "@/app/shared-links";
import { deletePortfolioFromShared, newSharedPortfolio, report, uploadFolderToShared } from "@/app/shared-actions";
import { ShareMirror } from "./ShareMirror";
import { VisibilityProvider } from "./visibility";
import { useVault } from "@/app/vault/store";
import type { ManualKind, ViewMode } from "@/domain/vault/types";
import { CommandPalette } from "./CommandPalette";
import { ContextPane, ContextRail } from "./ContextPane";
import { EditorPane } from "./EditorPane";
import { GraphView } from "./GraphView";
import { Sidebar, SidebarRail } from "./Sidebar";
import { NotePdfHost } from "./NotePdf";
import { ingestExternalFiles, isExternalFileDrag, readDroppedEntries } from "./ingest-files";
import { t } from "@/app/i18n";
import { useFullscreen, watchFullscreen } from "@/app/fullscreen";

type Pane = "files" | "note" | "graph" | "links";

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const apply = () => setMobile(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return mobile;
}

/**
 * La bóveda del usuario con sesión. No pinta nada hasta que el store tenga
 * cargada la bóveda de ese usuario, para no mostrar (ni replicar) la de otro.
 */
export function VaultApp() {
  const userId = useCurrentUser()?.id;
  const owner = useVault((state) => state.owner);
  // Los vínculos a lo compartido conmigo se quitan si pierdo el acceso.
  useSharedLinkCheck();

  useEffect(() => {
    if (userId) useVault.getState().openVaultFor(userId);
  }, [userId]);

  const canRead = useCan(PERMISSION.notesRead);

  if (!userId || owner !== userId) return null;
  if (!canRead) return <NoReadAccess />;
  return <VaultWorkspace />;
}

function NoReadAccess() {
  return (
    <div data-ui="shell" className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header data-ui="topbar" className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span className="flex items-center gap-0.5">
          <Mark />
          <span className="select-none font-semibold tracking-tight">{t("Grafito")}</span>
        </span>
        <span className="flex-1" />
        <AccountMenu />
      </header>
      <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">
        {t("Tu rol no tiene permiso para leer notas.")}
      </p>
    </div>
  );
}

function VaultWorkspace() {
  const owner = useVault((state) => state.owner);
  const mobile = useIsMobile();
  const [pane, setPane] = useState<Pane>("note");
  const [treeOpen, setTreeOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const graph = useVault((state) => state.graph);
  const activeId = useVault((state) => state.activeId);
  const sharedTree = useSharedView((state) => state.tree);
  const sharedDoc = useSharedView((state) => state.docId);
  const sharedPortfolio = useSharedView((state) => state.portfolioId);
  const trashOpen = useTrashView((state) => state.open);
  const setGraph = useVault((state) => state.setGraph);
  const setPalette = useVault((state) => state.setPalette);
  const createDocument = useVault((state) => state.createDocument);
  const selectedPortfolioId = useVault((state) => state.selectedPortfolioId);
  const canGraph = useCan(PERMISSION.graphView);
  const canCreate = useCan(PERMISSION.notesCreate);
  const canAddFiles = useCan(PERMISSION.filesUpload) || canCreate;

  const holdGraph = graph && !mobile;


  const openNote = (id: string) => {
    if (id) useVault.getState().setActive(id);
    setGraph(false);
    setPane("note");
  };

  // El grafo es el de lo que está abierto: un espacio de trabajo o algo
  // compartido conmigo, o si no la Carpeta Personal.
  const graphView = sharedTree ? (
    <GraphView
      onOpenNote={(id) => {
        setGraph(false);
        useSharedView.getState().openShared(sharedTree, id);
      }}
      source={{
        name: sharedTree.share.title,
        documents: asDocuments(orderDocuments(sharedTree)),
        portfolios: sharedTree.portfolios,
        activeId: sharedDoc,
        onSelect: (id) => useSharedView.getState().openShared(sharedTree, id),
      }}
    />
  ) : (
    <GraphView onOpenNote={openNote} />
  );

  const inspect = (id: string) => {
    if (id) useVault.getState().selectInGraph(id);
    setPane("graph");
  };

  const showFiles = () => setPane("files");

  // Un documento compartido conmigo, o la papelera, ocupa el área principal
  // hasta que se abre una nota propia o se vuelve a la raíz.
  const openSharedDoc = () => {
    useTrashView.getState().setOpen(false);
    useVault.getState().closeActive();
    setPane("note");
  };

  const openTrash = () => {
    useSharedView.getState().closeShared();
    useVault.getState().closeActive();
    useTrashView.getState().setOpen(true);
    setPane("note");
  };

  useEffect(() => {
    if (!activeId) return;
    useSharedView.getState().closeShared();
    useTrashView.getState().setOpen(false);
  }, [activeId]);

  const sharedPane = trashOpen ? (
    <TrashBoard />
  ) : sharedTree ? (
    <div className="flex h-full min-h-0 flex-col">
      <SharedViewer
        tree={sharedTree}
        docId={sharedDoc}
        portfolioId={sharedPortfolio}
        index={false}
        onOpenDoc={(id) => useSharedView.getState().openShared(sharedTree, id)}
        onOpenPortfolio={(id) => useSharedView.getState().openSharedPortfolio(sharedTree, id)}
        onChange={(next, id) =>
          id || sharedDoc
            ? useSharedView.getState().openShared(next, id ?? sharedDoc)
            : useSharedView.getState().openSharedPortfolio(next, sharedPortfolio)
        }
      />
    </div>
  ) : null;

  const closeNote = () => {
    useVault.getState().closeActive();
    setPane("files");
  };

  // Al volver desde Cuenta o Administración, sin un cursor suelto en «Filtrar».
  useEffect(() => {
    clearStrayCaret();
    const frame = requestAnimationFrame(clearStrayCaret);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (pluginFlagsFresh()) return;
    void listPlugins()
      .then((flags) => {
        if (Object.keys(flags).length > 0) setPluginFlags(flags);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (useFullscreen.getState().on && !useVault.getState().dialog && !useAiChat.getState().open) {
          useFullscreen.getState().exit();
          return;
        }
        if (useAiChat.getState().open) {
          useAiChat.getState().setOpen(false);
          return;
        }
        const state = useVault.getState();
        if (state.palette) {
          state.setPalette(false);
          return;
        }
        if (state.dialog) {
          state.setDialog(null);
          return;
        }
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          target.blur();
          return;
        }
        const hadChrome = state.graph || state.activeId || state.selectedPortfolioId || state.rootPicked;
        state.clearSelection();
        // La fila que se había pulsado conserva el foco, y Esc (teclado) le
        // dibujaría el anillo de foco: se suelta junto con la selección.
        releaseFocus();
        if (hadChrome) setPane("files");
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        const state = useVault.getState();
        state.setPalette(!state.palette);
      } else if (key === "n") {
        event.preventDefault();
        if (useVault.getState().createDocument()) setPane("note");
      } else if (key === "e" && !event.shiftKey) {
        event.preventDefault();
        const mode = useVault.getState().mode;
        const narrow = window.matchMedia("(max-width: 767px)").matches;
        const next: ViewMode =
          mode === "read" ? "edit" : mode === "edit" && !narrow ? "split" : "read";
        useVault.getState().setMode(next);
      } else if (key === "b") {
        // En el editor de la nota, Ctrl+B es negrita; en el resto, el chat de IA.
        const target = event.target;
        if (target instanceof HTMLTextAreaElement && target.getAttribute("aria-label") === "Contenido de la nota") return;
        event.preventDefault();
        useAiChat.getState().toggle();
      } else if (key === "g") {
        event.preventDefault();
        useVault.getState().toggleGraph();
        setPane(useVault.getState().graph ? "graph" : "note");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const blockNavigate = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !isExternalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener("dragover", blockNavigate);
    window.addEventListener("drop", blockNavigate);
    return () => {
      window.removeEventListener("dragover", blockNavigate);
      window.removeEventListener("drop", blockNavigate);
    };
  }, []);

  const toggleTree = () => {
    // Sin recordar: al volver a la bóveda el directorio aparece desplegado.
    setTreeOpen((open) => !open);
  };

  const fullscreen = useFullscreen((state) => state.on);
  useEffect(() => watchFullscreen(), []);
  // Sin nada abierto no hay qué ver a pantalla completa.
  const nothingOpen = useVault((state) => !state.activeId) && !sharedPane;
  useEffect(() => {
    if (fullscreen && nothingOpen) useFullscreen.getState().exit();
  }, [fullscreen, nothingOpen]);

  const showPortfolio = (id: string) => {
    useSharedView.getState().closeShared();
    useTrashView.getState().setOpen(false);
    useVault.getState().openPortfolio(id);
    setPane("note");
  };

  const showHome = () => {
    useSharedView.getState().closeShared();
    useTrashView.getState().setOpen(false);
    const state = useVault.getState();
    state.setPalette(false);
    state.setDialog(null);
    state.closeActive();
    state.setGraph(false);
    state.setSelectedPortfolio(null);
    setPane("note");
  };

  const goHome = () => {
    useSharedView.getState().closeShared();
    useTrashView.getState().setOpen(false);
    useVault.getState().showStart();
    setPane("note");
  };

  return (
    <VisibilityProvider>
    <div data-ui="shell" className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      {fullscreen ? null : (
      <header data-ui="topbar" className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <button
          type="button"
          aria-label={t("Inicio")}
          onClick={goHome}
          onContextMenu={(event) => event.preventDefault()}
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-md pr-1 text-fg transition-opacity hover:opacity-80"
        >
          <Mark />
          <span className="select-none font-semibold tracking-tight">{t("Grafito")}</span>
        </button>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md bg-inset px-3 text-left text-sm text-muted"
        >
          <Search className="size-4 shrink-0" />
          <span className="truncate">{t("Buscar")}</span>
          <span className="ml-auto hidden text-xs text-faint lg:inline">{t("Ctrl K")}</span>
        </button>
        <AccountMenu />
        {canGraph ? (
        <button
          type="button"
          aria-label={graph ? t("Cerrar grafo") : t("Abrir grafo")}
          aria-pressed={graph}
          onClick={() => {
            const next = !graph;
            setGraph(next);
            setPane(next ? "graph" : "note");
          }}
          className={`hidden h-11 w-11 shrink-0 place-items-center rounded-md md:grid ${
            graph ? "text-accent" : "text-muted hover:text-fg"
          }`}
        >
          <Network className="size-4" />
        </button>
        ) : null}
        {canCreate ? (
          <button
            type="button"
            aria-label={t("Nueva nota")}
            onClick={() => {
              createDocument(selectedPortfolioId);
              setPane("note");
            }}
            className="ml-2 grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent text-accent-fg"
          >
            <Plus className="size-4" />
          </button>
        ) : null}
      </header>
      )}

      <div data-ui="panes" className="flex min-h-0 flex-1">
        {fullscreen ? (
          // Pantalla completa: solo la nota o el archivo abierto (ver `app/fullscreen.ts`).
          <div data-ui="workspace" className="min-h-0 min-w-0 flex-1">
            <FileDrop enabled={canAddFiles}>
              {sharedPane ?? <EditorPane mobile={mobile} onOpenNote={openNote} onFilter={showFiles} onClose={closeNote} />}
            </FileDrop>
          </div>
        ) : mobile ? (
          pane === "files" ? (
            <Sidebar
              onOpenNote={openNote}
              onInspect={inspect}
              onHome={showHome}
              onOpenPortfolio={showPortfolio}
              onOpenShared={openSharedDoc}
              onOpenTrash={openTrash}
              holdGraph={holdGraph}
            />
          ) : pane === "graph" ? (
            <FileDrop enabled={canAddFiles}>
              {graphView}
            </FileDrop>
          ) : pane === "links" ? (
            <ContextPane onOpenNote={openNote} onInspect={inspect} holdGraph={holdGraph} onFilter={showFiles} />
          ) : sharedPane ? (
            <FileDrop enabled={canAddFiles}>
              {sharedPane}
            </FileDrop>
          ) : (
            <FileDrop enabled={canAddFiles}>
              <EditorPane mobile onOpenNote={openNote} onFilter={showFiles} onClose={closeNote} />
            </FileDrop>
          )
        ) : (
          <>
            {treeOpen ? (
              <Sidebar
                onOpenNote={openNote}
                onInspect={inspect}
                onHome={showHome}
                onOpenPortfolio={showPortfolio}
                onOpenShared={openSharedDoc}
                onOpenTrash={openTrash}
                onCollapse={toggleTree}
                holdGraph={holdGraph}
              />
            ) : (
              <SidebarRail onExpand={toggleTree} />
            )}
            <div data-ui="workspace" className="min-h-0 min-w-0 flex-1">
              <FileDrop enabled={canAddFiles}>
                {graph ? (
                  graphView
                ) : sharedPane ? (
                  sharedPane
                ) : (
                  <EditorPane mobile={false} onOpenNote={openNote} onFilter={showFiles} onClose={closeNote} />
                )}
              </FileDrop>
            </div>
            <div data-ui="context-slot" className="hidden h-full lg:block">
              {detailsOpen ? (
                <ContextPane
                  onOpenNote={openNote}
                  onInspect={inspect}
                  holdGraph={holdGraph}
                  onFilter={showFiles}
                  onCollapse={() => setDetailsOpen(false)}
                />
              ) : (
                <ContextRail onExpand={() => setDetailsOpen(true)} />
              )}
            </div>
          </>
        )}
      </div>

      {mobile && !fullscreen ? (
        <nav data-ui="tabbar" className={`grid h-16 shrink-0 border-t border-line bg-surface ${canGraph ? "grid-cols-4" : "grid-cols-3"}`}>
          <NavButton active={pane === "files"} label={t("Notas")} onClick={() => setPane("files")}>
            <Folder className="size-5" />
          </NavButton>
          <NavButton active={pane === "note"} label={t("Nota")} onClick={() => { setGraph(false); setPane("note"); }}>
            <FileText className="size-5" />
          </NavButton>
          {canGraph ? (
            <NavButton
              active={pane === "graph"}
              label={t("Grafo")}
              onClick={() => {
                setGraph(true);
                setPane("graph");
              }}
            >
              <Network className="size-5" />
            </NavButton>
          ) : null}
          <NavButton active={pane === "links"} label={t("Vínculos")} onClick={() => setPane("links")}>
            <Link2 className="size-5" />
          </NavButton>
        </nav>
      ) : null}

      <CommandPalette onOpenNote={openNote} onInspect={inspect} holdGraph={holdGraph} />
      <VaultDialogs />
      <VaultMirror />
      <TableIndexSync ownerId={owner} />
      <VaultSync />
      <ShareMirror />
      <NotePdfHost />
      <AiChat mobile={mobile} onOpenNote={openNote} />
    </div>
    </VisibilityProvider>
  );
}

function FileDrop({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const place = () => {
    const view = useSharedView.getState();
    const tree = view.tree;
    if (tree && tree.share.kind !== "portfolio") {
      return { kind: "shared" as const, shareId: tree.share.id, portfolioId: null, name: tree.share.title, ok: false };
    }
    if (tree?.share.kind === "portfolio") {
      const root = tree.portfolios.find((portfolio) => portfolio.parentId === rootParent(tree))?.id ?? null;
      const fromDoc = view.docId ? (tree.documents.find((document) => document.id === view.docId)?.portfolioId ?? null) : null;
      const portfolioId = view.docId
        ? fromDoc && tree.portfolios.some((portfolio) => portfolio.id === fromDoc)
          ? fromDoc
          : root
        : view.portfolioId && tree.portfolios.some((portfolio) => portfolio.id === view.portfolioId)
          ? view.portfolioId
          : root;
      const name = tree.portfolios.find((portfolio) => portfolio.id === portfolioId)?.name ?? tree.share.title;
      return { kind: "shared" as const, shareId: tree.share.id, portfolioId, name, ok: canEditSharedPortfolio(tree, portfolioId) };
    }
    const state = useVault.getState();
    const active = state.documents.find((document) => document.id === state.activeId);
    const portfolioId = active ? active.portfolioId : state.selectedPortfolioId;
    const name = state.portfolios.find((portfolio) => portfolio.id === portfolioId)?.name ?? t("Carpeta Personal");
    return { kind: "personal" as const, portfolioId, name, ok: true };
  };

  return (
    <div
      className="relative h-full min-h-0 min-w-0"
      onDragEnter={(event) => {
        if (!enabled || !isExternalFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!enabled || !isExternalFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!enabled || !isExternalFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const target = place();
        void readDroppedEntries(event.dataTransfer).then((files) => {
          if (files.length === 0) return;
          if (target.kind === "shared") {
            if (!target.ok) {
              report(t("No puedes añadir nada a ese portafolio."));
              return;
            }
            void uploadFolderToShared(target.shareId, target.portfolioId, files).then(report);
            return;
          }
          void ingestExternalFiles(files, target.portfolioId);
        });
      }}
    >
      {children}
      {over ? (
        <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg/80 text-sm text-fg">
          {place().ok ? <>{t("Soltar para agregar a")}{" "}{place().name}</> : t("No puedes añadir nada a ese portafolio.")}
        </div>
      ) : null}
    </div>
  );
}

function NavButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1 text-xs ${active ? "text-accent" : "text-muted"}`}
    >
      {children}
      {label}
    </button>
  );
}

type LinkCandidate = { key: string; targetId: string; target?: "portfolio"; shareId?: string; title: string; detail: string };

function VaultDialogs() {
  const dialog = useVault((state) => state.dialog);
  const setDialog = useVault((state) => state.setDialog);
  const createPortfolio = useVault((state) => state.createPortfolio);
  const deleteDocument = useVault((state) => state.deleteDocument);
  const deletePortfolio = useVault((state) => state.deletePortfolio);
  const rename = useVault((state) => state.rename);
  const renamePortfolio = useVault((state) => state.renamePortfolio);
  const resolveMove = useVault((state) => state.resolveMove);
  const addManualLink = useVault((state) => state.addManualLink);
  const reset = useVault((state) => state.reset);
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const [name, setName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [kind, setKind] = useState<ManualKind>("referencia");
  const [query, setQuery] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linking, setLinking] = useState(false);
  const [shared, setShared] = useState<Awaited<ReturnType<typeof sharedCandidates>>>([]);
  const openTree = useSharedView((state) => state.tree);

  useEffect(() => {
    if (dialog?.type === "portfolio") setName("");
    if (dialog?.type === "shared-portfolio") {
      setName("");
      setRenameError("");
    }
    if (dialog?.type === "rename-document") {
      setName(useVault.getState().documents.find((item) => item.id === dialog.id)?.title ?? "");
      setRenameError("");
    }
    if (dialog?.type === "rename-portfolio") {
      setName(useVault.getState().portfolios.find((item) => item.id === dialog.id)?.name ?? "");
      setRenameError("");
    }
    if (dialog?.type === "link") {
      setKind("referencia");
      setQuery("");
      setLinkError("");
      setLinking(false);
      // En un espacio el destino es de ese espacio. En la carpeta personal, también lo compartido conmigo.
      setShared([]);
      if (!dialog.shareId) void sharedCandidates().then(setShared);
    }
  }, [dialog]);

  /** Notas, archivos y portafolios propios, y lo compartido conmigo. */
  const candidates = useMemo(() => {
    if (dialog?.type !== "link") return [];
    const needle = query.trim().toLowerCase();
    if (dialog.shareId) {
      const tree = openTree?.share.id === dialog.shareId ? openTree : null;
      const here: LinkCandidate[] = [
        ...(tree?.documents ?? []).map((document) => ({
          key: document.id,
          targetId: document.id,
          title: document.title,
          detail: document.kind === "file" ? t("archivo") : t("nota"),
        })),
        ...(tree?.portfolios ?? []).map((portfolio) => ({
          key: `p:${portfolio.id}`,
          targetId: portfolio.id,
          target: "portfolio" as const,
          title: portfolio.name,
          detail: t("portafolio"),
        })),
      ];
      return here
        .filter((item) => item.targetId !== dialog.sourceId)
        .filter((item) => !needle || item.title.toLowerCase().includes(needle))
        .slice(0, 40);
    }
    const all: LinkCandidate[] = [
      ...documents.map((document) => ({
        key: document.id,
        targetId: document.id,
        title: document.title,
        detail: document.kind === "file" ? t("archivo") : t("nota"),
      })),
      ...portfolios.map((portfolio) => ({
        key: `p:${portfolio.id}`,
        targetId: portfolio.id,
        target: "portfolio" as const,
        title: portfolio.name,
        detail: t("portafolio"),
      })),
      ...shared.map((item) => ({
        key: `s:${item.shareId}:${item.targetId}`,
        targetId: item.targetId,
        target: item.target,
        shareId: item.shareId,
        title: item.title,
        detail: `${item.kind === "portfolio" ? t("portafolio") : item.kind === "file" ? t("archivo") : t("nota")} · ${item.ownerName}`,
      })),
    ];
    return all
      .filter((item) => item.targetId !== dialog.sourceId)
      .filter((item) => !needle || item.title.toLowerCase().includes(needle))
      .slice(0, 12);
  }, [dialog, documents, portfolios, shared, query, openTree]);

  if (!dialog) return null;

  if (dialog.type === "signatures") {
    return <SignatureDialog docId={dialog.docId} shareId={dialog.shareId} onClose={() => setDialog(null)} />;
  }

  if (dialog.type === "share") {
    return <ShareDialog kind={dialog.kind} id={dialog.id} onClose={() => setDialog(null)} />;
  }

  if (dialog.type === "shared-portfolio") {
    return (
      <Modal title={t("Nuevo portafolio")} onClose={() => setDialog(null)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const clean = name.trim();
            if (!clean) return;
            void newSharedPortfolio(dialog.shareId, dialog.parentId, clean).then((error) => {
              if (error) setRenameError(error);
              else setDialog(null);
            });
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            aria-label={t("Nombre del portafolio")}
            className="h-11 w-full rounded-md border border-line bg-inset px-3 text-sm outline-none"
          />
          {renameError ? <p className="mt-2 text-sm text-danger">{t(renameError)}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
            <Primary type="submit">{t("Crear")}</Primary>
          </div>
        </form>
      </Modal>
    );
  }

  if (dialog.type === "space") {
    return <SpaceDialog portfolioId={dialog.portfolioId} shareId={dialog.shareId} onClose={() => setDialog(null)} />;
  }

  if (dialog.type === "git") {
    return <GitDialog portfolioId={dialog.portfolioId} onClose={() => setDialog(null)} />;
  }

  if (dialog.type === "portfolio") {
    const parent = portfolios.find((item) => item.id === dialog.parentId);
    return (
      <Modal title={t("Nuevo portafolio")} onClose={() => setDialog(null)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createPortfolio(dialog.parentId, name);
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={parent ? t("Dentro de {0}", { 0: parent.name }) : t("Nombre")}
            className="h-11 w-full rounded-md border border-line bg-inset px-3 text-sm outline-none"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
            <Primary type="submit">{t("Crear")}</Primary>
          </div>
        </form>
      </Modal>
    );
  }

  if (dialog.type === "rename-document" || dialog.type === "rename-portfolio") {
    const current =
      dialog.type === "rename-document"
        ? documents.find((item) => item.id === dialog.id)?.title
        : portfolios.find((item) => item.id === dialog.id)?.name;
    return (
      <Modal title={t("Renombrar")} onClose={() => setDialog(null)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) {
              setRenameError(t("Escribe un nombre."));
              return;
            }
            const ok =
              dialog.type === "rename-document" ? rename(dialog.id, name) : renamePortfolio(dialog.id, name);
            if (!ok) {
              setRenameError(t("Ese nombre ya está en este lugar."));
              setName(current ?? "");
              return;
            }
            setRenameError("");
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setRenameError("");
            }}
            aria-label={t("Nombre")}
            className="h-11 w-full rounded-md border border-line bg-inset px-3 text-sm outline-none"
          />
          {renameError ? <p className="mt-2 text-xs text-danger">{t(renameError)}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
            <Primary type="submit">{t("Guardar")}</Primary>
          </div>
        </form>
      </Modal>
    );
  }

  if (dialog.type === "move-conflict") {
    const source = documents.find((item) => item.id === dialog.id);
    const place = portfolios.find((item) => item.id === dialog.portfolioId)?.name ?? t("Carpeta Personal");
    return (
      <Modal title={t("Mismo nombre")} onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">
          {t("Ya hay un «{0}» en {1}. Reemplazar borra el que ya estaba. Renombrar mueve este con otro nombre.", {
            0: source?.title ?? t("documento"),
            1: place,
          })}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
          <Primary type="button" onClick={() => resolveMove("rename")}>
            {t("Renombrar")}
          </Primary>
          <Danger onClick={() => resolveMove("replace")}>{t("Reemplazar")}</Danger>
        </div>
      </Modal>
    );
  }

  if (dialog.type === "delete-document") {
    const document = documents.find((item) => item.id === dialog.id);
    return (
      <Modal title={t("Eliminar documento")} onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">
          {t("«{0}» irá a la papelera.", { 0: document?.title ?? t("Este documento") })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
          <Danger onClick={() => deleteDocument(dialog.id)}>{t("Eliminar")}</Danger>
        </div>
      </Modal>
    );
  }

  if (dialog.type === "delete-portfolio") {
    const portfolio = portfolios.find((item) => item.id === dialog.id);
    const shareId = dialog.shareId;
    return (
      <Modal title={t("Eliminar portafolio")} onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">
          {t("«{0}» y todo lo que contiene irán a la papelera.", { 0: dialog.name ?? portfolio?.name ?? t("Este portafolio") })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
          <Danger
            onClick={() => {
              if (!shareId) return deletePortfolio(dialog.id);
              setDialog(null);
              void deletePortfolioFromShared(shareId, dialog.id).then(report);
            }}
          >
            {t("Eliminar portafolio")}
          </Danger>
        </div>
      </Modal>
    );
  }

  if (dialog.type === "delete-many") {
    const folders = dialog.keys.filter((key) => key.startsWith("port:")).length;
    const docs = dialog.keys.length - folders;
    const parts = [
      folders ? (folders === 1 ? t("1 portafolio") : t("{n} portafolios", { n: folders })) : "",
      docs ? (docs === 1 ? t("1 documento") : t("{n} documentos", { n: docs })) : "",
    ].filter(Boolean);
    return (
      <Modal title={t("Eliminar {n} elementos", { n: dialog.keys.length })} onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">
          {t("{0} irán a la papelera (los portafolios, con todo lo que contienen).", { 0: parts.join(t(" y ")) })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
          <Danger onClick={() => useVault.getState().deleteMany(dialog.keys)}>{t("Eliminar")}</Danger>
        </div>
      </Modal>
    );
  }

  if (dialog.type === "link") {
    return (
      <Modal title={t("Vincular")} onClose={() => setDialog(null)}>
        {dialog.anchor ? (
          <p className="mb-3 rounded-md bg-inset px-3 py-2 text-sm">
            «{dialog.anchor.exact}»
            <span className="text-faint">{" · "}{t("pág. {0}", { 0: dialog.anchor.page })}</span>
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <KindButton active={kind === "referencia"} label={t("Referencia")} onClick={() => setKind("referencia")} />
          <KindButton active={kind === "llama"} label={t("Invoca")} onClick={() => setKind("llama")} />
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Buscar destino")}
          className="mt-3 h-11 w-full rounded-md border border-line bg-inset px-3 text-sm outline-none"
        />
        <ul className="mt-2 max-h-56 overflow-y-auto">
          {candidates.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                disabled={linking}
                onClick={() => {
                  if (!dialog.shareId) {
                    addManualLink(dialog.sourceId, item.targetId, kind, dialog.anchor, {
                      target: item.target,
                      shareId: item.shareId,
                    });
                    return;
                  }
                  setLinking(true);
                  setLinkError("");
                  void commitSharedLink(dialog.shareId, dialog.sourceId, {
                    add: {
                      targetId: item.targetId,
                      kind,
                      ...(item.target ? { target: item.target } : {}),
                      ...(dialog.anchor ? { anchor: dialog.anchor } : {}),
                    },
                  }).then((error) => {
                    if (error) {
                      setLinkError(error);
                      setLinking(false);
                      return;
                    }
                    setDialog(null);
                  });
                }}
                className="flex h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-elevated disabled:opacity-50"
              >
                <span className="truncate">{item.title}</span>
                <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-faint">{item.detail}</span>
              </button>
            </li>
          ))}
          {candidates.length === 0 ? <li className="px-2 py-3 text-sm text-faint">{t("No hay destinos.")}</li> : null}
        </ul>
        {linkError ? <p className="mt-2 text-sm text-danger">{t(linkError)}</p> : null}
      </Modal>
    );
  }

  if (dialog.type === "upload-error") {
    return (
      <Modal title={t(dialog.title ?? "No se pudo subir")} onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">{t(dialog.message)}</p>
        <div className="mt-4 flex justify-end">
          <Primary onClick={() => setDialog(null)}>{t("Entendido")}</Primary>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t("Restaurar el ejemplo")} onClose={() => setDialog(null)}>
      <p className="text-sm text-muted">
        {t("Esto sustituye la bóveda actual por los portafolios de ejemplo, incluido Inicio. Lo que hayas escrito aquí se pierde.")}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
        <Danger onClick={reset}>{t("Restaurar")}</Danger>
      </div>
    </Modal>
  );
}

function KindButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 rounded-md text-sm ${active ? "bg-accent text-accent-fg" : "bg-inset text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
}

function Ghost({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg">
      {children}
    </button>
  );
}

function Primary({
  children,
  type = "button",
  onClick,
}: {
  children: ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
}) {
  return (
    <button type={type} onClick={onClick} className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
      {children}
    </button>
  );
}

function Danger({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-11 rounded-md bg-danger px-4 text-sm font-medium text-accent-fg">
      {children}
    </button>
  );
}
