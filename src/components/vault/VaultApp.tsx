import {
  FileText,
  Folder,
  Link2,
  Network,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { Modal } from "@/components/ui/Modal";
import { AccountMenu } from "@/components/chrome/ChromeHeader";
import { listPlugins } from "@/server/admin.functions";
import { pluginFlagsFresh, setPluginFlags } from "@/app/plugins";
import { useCan } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { VaultMirror } from "./VaultMirror";
import { VaultSync } from "./VaultSync";
import { AiChat } from "@/components/ai/AiChat";
import { useAiChat } from "@/app/ai-chat";
import { useSharedView } from "@/app/shared-view";
import { useTrashView } from "@/app/trash-view";
import { SharedViewer } from "@/components/share/SharedViewer";
import { TrashBoard } from "./TrashBoard";
import { ShareDialog } from "./ShareDialog";
import { ShareMirror } from "./ShareMirror";
import { VisibilityProvider } from "./visibility";
import { useVault } from "@/app/vault/store";
import type { ManualKind, ViewMode } from "@/domain/vault/types";
import { CommandPalette } from "./CommandPalette";
import { ContextPane } from "./ContextPane";
import { EditorPane } from "./EditorPane";
import { GraphView } from "./GraphView";
import { Sidebar, SidebarRail } from "./Sidebar";
import { NotePdfHost } from "./NotePdf";
import { ingestExternalFiles, isExternalFileDrag } from "./ingest-files";
import { t } from "@/app/i18n";

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
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
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
  const mobile = useIsMobile();
  const [pane, setPane] = useState<Pane>("note");
  const [treeOpen, setTreeOpen] = useState(true);
  const graph = useVault((state) => state.graph);
  const activeId = useVault((state) => state.activeId);
  const sharedTree = useSharedView((state) => state.tree);
  const sharedDoc = useSharedView((state) => state.docId);
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
        index={false}
        onOpenDoc={(id) => useSharedView.getState().openShared(sharedTree, id)}
        onChange={(next) => useSharedView.getState().openShared(next, sharedDoc)}
      />
    </div>
  ) : null;

  const closeNote = () => {
    useVault.getState().closeActive();
    setPane("files");
  };

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
    setTreeOpen(localStorage.getItem("grafito.sidebar") !== "0");
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
    setTreeOpen((open) => {
      const next = !open;
      localStorage.setItem("grafito.sidebar", next ? "1" : "0");
      return next;
    });
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
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
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

      <div className="flex min-h-0 flex-1">
        {mobile ? (
          pane === "files" ? (
            <Sidebar
              onOpenNote={openNote}
              onInspect={inspect}
              onHome={showHome}
              onOpenShared={openSharedDoc}
              onOpenTrash={openTrash}
              holdGraph={holdGraph}
            />
          ) : pane === "graph" ? (
            <FileDrop enabled={canAddFiles} onAdded={openNote}>
              <GraphView onOpenNote={openNote} />
            </FileDrop>
          ) : pane === "links" ? (
            <ContextPane onOpenNote={openNote} onInspect={inspect} holdGraph={holdGraph} onFilter={showFiles} />
          ) : sharedPane ? (
            sharedPane
          ) : (
            <FileDrop enabled={canAddFiles} onAdded={openNote}>
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
                onOpenShared={openSharedDoc}
                onOpenTrash={openTrash}
                onCollapse={toggleTree}
                holdGraph={holdGraph}
              />
            ) : (
              <SidebarRail onExpand={toggleTree} />
            )}
            <div className="min-h-0 min-w-0 flex-1">
              <FileDrop enabled={canAddFiles} onAdded={openNote}>
                {graph ? (
                  <GraphView onOpenNote={openNote} />
                ) : sharedPane ? (
                  sharedPane
                ) : (
                  <EditorPane mobile={false} onOpenNote={openNote} onFilter={showFiles} onClose={closeNote} />
                )}
              </FileDrop>
            </div>
            <div className="hidden h-full lg:block">
              <ContextPane onOpenNote={openNote} onInspect={inspect} holdGraph={holdGraph} onFilter={showFiles} />
            </div>
          </>
        )}
      </div>

      {mobile ? (
        <nav className={`grid h-16 shrink-0 border-t border-line bg-surface ${canGraph ? "grid-cols-4" : "grid-cols-3"}`}>
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
  onAdded,
  children,
}: {
  enabled: boolean;
  onAdded: (id: string) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const place = () => {
    const state = useVault.getState();
    const active = state.documents.find((document) => document.id === state.activeId);
    const portfolioId = active ? active.portfolioId : state.selectedPortfolioId;
    const name = state.portfolios.find((portfolio) => portfolio.id === portfolioId)?.name ?? t("Raíz");
    return { portfolioId, name };
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
        const { portfolioId } = place();
        void ingestExternalFiles(event.dataTransfer.files, portfolioId).then(() => {
          onAdded(useVault.getState().activeId ?? "");
        });
      }}
    >
      {children}
      {over ? (
        <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg/80 text-sm text-fg">
          {t("Soltar para agregar a")}{" "}{place().name}
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

  useEffect(() => {
    if (dialog?.type === "portfolio") setName("");
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
    }
  }, [dialog]);

  const candidates = useMemo(() => {
    if (dialog?.type !== "link") return [];
    const needle = query.trim().toLowerCase();
    return documents
      .filter((document) => document.id !== dialog.sourceId)
      .filter((document) => !needle || document.title.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [dialog, documents, query]);

  if (!dialog) return null;

  if (dialog.type === "share") {
    return <ShareDialog kind={dialog.kind} id={dialog.id} onClose={() => setDialog(null)} />;
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
    const place = portfolios.find((item) => item.id === dialog.portfolioId)?.name ?? t("Raíz");
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
    return (
      <Modal title={t("Eliminar portafolio")} onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">
          {t("«{0}» y todo lo que contiene irán a la papelera.", { 0: portfolio?.name ?? t("Este portafolio") })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Ghost onClick={() => setDialog(null)}>{t("Cancelar")}</Ghost>
          <Danger onClick={() => deletePortfolio(dialog.id)}>{t("Eliminar portafolio")}</Danger>
        </div>
      </Modal>
    );
  }

  if (dialog.type === "link") {
    return (
      <Modal title={t("Vincular")} onClose={() => setDialog(null)}>
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
          {candidates.map((document) => (
            <li key={document.id}>
              <button
                type="button"
                onClick={() => addManualLink(dialog.sourceId, document.id, kind)}
                className="flex h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-elevated"
              >
                <span className="truncate">{document.title}</span>
                <span className="ml-auto shrink-0 text-xs text-faint">
                  {document.kind === "file" ? t("archivo") : t("nota")}
                </span>
              </button>
            </li>
          ))}
          {candidates.length === 0 ? <li className="px-2 py-3 text-sm text-faint">{t("No hay destinos.")}</li> : null}
        </ul>
      </Modal>
    );
  }

  if (dialog.type === "upload-error") {
    return (
      <Modal title={t("No se pudo subir")} onClose={() => setDialog(null)}>
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
