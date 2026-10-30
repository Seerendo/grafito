import {
  BookOpen,
  ChevronRight,
  FilePlus,
  FolderPlus,
  FolderUp,
  HardDrive,
  Upload,
  File,
  FileText,
  FolderOpen,
  Globe,
  History,
  ListTree,
  MessageSquare,
  PenLine,
  Trash2,
  Users,
  Waypoints,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FileView } from "@/components/vault/FileView";
import { HistoryDialog } from "@/components/vault/HistoryDialog";
import { MarkdownView } from "@/components/vault/MarkdownView";
import { editSharedDoc } from "@/server/history.functions";
import type { PublishedDoc, SharedTree } from "@/server/share";
import { asDocuments, canEditSharedPortfolio, canManageSharedSpace, childrenOf, docsIn, orderDocuments, rootParent, sharedPortfolioLevel } from "./shared-tree";
import { intl, t } from "@/app/i18n";
import { useNotePresence } from "@/app/presence";
import { EditingNow } from "@/components/vault/EditingNow";
import { SignatureBar } from "@/components/vault/SignatureDialog";
import { FullscreenButton } from "@/components/vault/FullscreenButton";
import { Comments } from "@/components/vault/Comments";
import { GraphView } from "@/components/vault/GraphView";
import { SharedBoard } from "./SharedBoard";
import { SharedContext } from "./SharedContext";
import { publicDocContent, sharedDocContent } from "@/server/share.functions";
import { fetchSharedTree } from "@/app/shared-open";
import { addSharedFile, createSharedNote, createSharedPortfolio } from "@/server/space.functions";
import { Modal } from "@/components/ui/Modal";
import { deleteFromShared, uploadFolderToShared } from "@/app/shared-actions";
import { uploadVaultFile } from "@/app/files";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";

/**
 * Visor de una nota o un portafolio compartido: índice a la izquierda (o
 * arriba en móvil) y el documento elegido. Dentro de la bóveda el índice lo
 * pone el directorio (`index={false}`) y el documento abierto llega por
 * `docId`/`onOpenDoc`. Con acceso de edición y `onChange`, las notas se pueden
 * editar y ver su historial; al guardar se avisa con el árbol actualizado.
 * Para moverse rápido, también en un enlace público: el grafo de lo publicado
 * y un panel con el esquema, los vínculos y las menciones (solo lectura).
 * En la bóveda, con `onOpenPortfolio` y sin documento abierto, se ve la página
 * del portafolio `portfolioId` (o del compartido): sus portafolios y recientes.
 */
export function SharedViewer({
  tree,
  docId,
  portfolioId = null,
  onOpenDoc,
  onOpenPortfolio,
  onChange,
  index = true,
}: {
  tree: SharedTree;
  docId?: string | null;
  portfolioId?: string | null;
  onOpenDoc?: (id: string) => void;
  onOpenPortfolio?: (id: string | null) => void;
  /** Con `docId`, además abre ese documento (uno recién creado). */
  onChange?: (tree: SharedTree, docId?: string) => void;
  index?: boolean;
}) {
  const ordered = useMemo(() => orderDocuments(tree), [tree]);
  const [ownId, setOwnId] = useState<string | null>(ordered[0]?.id ?? null);
  const activeId = docId ?? ownId;
  const setActiveId = onOpenDoc ?? setOwnId;
  const board = Boolean(onOpenPortfolio) && !docId && tree.share.kind === "portfolio";
  const shown = board ? null : (ordered.find((document) => document.id === activeId) ?? ordered[0] ?? null);
  // El árbol llega sin el texto de las notas (`lazy`): se pide al abrir cada una.
  const [texts, setTexts] = useState<Record<string, { content: string; updatedAt: string; updatedBy: string }>>({});
  // Los que ya no están (borrados hace un momento, aunque el árbol aún los muestre).
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const text = shown ? texts[shown.id] : undefined;
  const missing = Boolean(shown && gone.has(shown.id));
  const loading = !missing && Boolean(shown?.lazy) && shown?.kind === "markdown" && (!text || text.updatedAt < shown.updatedAt);
  const active =
    shown?.lazy && text
      ? {
          ...shown,
          content: text.content,
          updatedAt: text.updatedAt > shown.updatedAt ? text.updatedAt : shown.updatedAt,
          updatedBy: text.updatedAt > shown.updatedAt ? text.updatedBy : shown.updatedBy,
        }
      : shown;
  useEffect(() => {
    if (!loading || !shown) return;
    let alive = true;
    const id = shown.id;
    const token = tree.share.token;
    void (token
      ? publicDocContent({ data: { token, docId: id } })
      : sharedDocContent({ data: { shareId: tree.share.id, docId: id } })
    )
      .then((result) => {
        if (!alive) return;
        if (result) setTexts((current) => ({ ...current, [id]: result }));
        else setGone((current) => new Set([...current, id]));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [loading, shown, tree.share.id, tree.share.token]);
  const byTitle = (name: string) => ordered.find((document) => document.title.toLowerCase() === name.toLowerCase());
  const single = tree.share.kind === "document" || !index;
  const Badge = tree.share.visibility === "public" ? Globe : Users;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState<{ content: string; updatedAt: number; updatedBy: string } | null>(null);
  const [history, setHistory] = useState(false);
  const dirty = editing && active !== null && draft !== active.content;
  // Comentarios: dentro de la bóveda (con sesión), también en solo lectura.
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [commentCount, setCommentCount] = useState(0);
  const canComment = Boolean(onChange) && active !== null;
  const editors = useNotePresence(active && !active.file ? active.id : null, editing, tree.share.id);
  const documents = useMemo(() => asDocuments(ordered), [ordered]);
  const [view, setView] = useState<"doc" | "graph">("doc");
  const [contextOpen, setContextOpen] = useState(true);
  const graphable = ordered.length > 1;
  const showGraph = view === "graph" && graphable;
  const openDoc = (id: string) => {
    setActiveId(id);
    setView("doc");
  };
  // Añadir en el portafolio abierto: en un espacio, solo donde esta persona puede editar.
  const sharedRoot = tree.portfolios.find((portfolio) => portfolio.parentId === rootParent(tree))?.id ?? null;
  const here = board
    ? portfolioId && tree.portfolios.some((portfolio) => portfolio.id === portfolioId)
      ? portfolioId
      : sharedRoot
    : active?.portfolioId && tree.portfolios.some((portfolio) => portfolio.id === active.portfolioId) ? active.portfolioId : sharedRoot;
  const hereName = tree.portfolios.find((portfolio) => portfolio.id === here)?.name ?? tree.share.title;
  const level = sharedPortfolioLevel(tree, here);
  const writable = canEditSharedPortfolio(tree, here);
  const canEdit = writable && Boolean(onChange) && active?.kind === "markdown" && !loading && !missing;
  const canAdd = writable && Boolean(onChange) && tree.share.kind === "portfolio";
  const showSpace = Boolean(onChange) && canManageSharedSpace(tree) && tree.share.kind === "portfolio" && Boolean(here);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const addPortfolio = async (name: string) => {
    setAdding(true);
    setMessage("");
    const result = await createSharedPortfolio({ data: { shareId: tree.share.id, parentId: here, name } }).catch(() => null);
    setAdding(false);
    if (!result?.ok) setMessage(result?.error ?? t("No se pudo crear el portafolio."));
    else {
      setNaming(null);
      await reload();
    }
  };
  const reload = async (docId?: string) => {
    const next = await fetchSharedTree(tree.share.id, true).catch(() => null);
    if (next) onChange?.(next, docId);
  };
  const addNote = async () => {
    setAdding(true);
    setMessage("");
    const result = await createSharedNote({ data: { shareId: tree.share.id, portfolioId: here, title: "" } }).catch(() => null);
    setAdding(false);
    if (!result?.ok) setMessage(result?.error ?? t("No se pudo crear la nota."));
    else {
      await reload(result.id);
      setView("doc");
    }
  };
  const addFiles = async (files: FileList) => {
    setAdding(true);
    setMessage("");
    let last: string | undefined;
    for (const file of [...files]) {
      try {
        const stored = await uploadVaultFile(file, { shareId: tree.share.id, portfolioId: here });
        const result = await addSharedFile({
          data: { shareId: tree.share.id, portfolioId: here, key: stored.key, name: file.name, mime: file.type },
        });
        if (!result.ok) {
          setMessage(result.error);
          break;
        }
        last = result.id;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("No se pudo subir."));
        break;
      }
    }
    setAdding(false);
    if (last) await reload(last);
  };
  const addFolder = async (files: FileList) => {
    setAdding(true);
    setMessage("");
    const error = await uploadFolderToShared(
      tree.share.id,
      here,
      [...files].map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })),
    );
    setAdding(false);
    if (error) setMessage(error);
  };

  useEffect(() => {
    setEditing(false);
    setConflict(null);
    setMessage("");
  }, [active?.id]);

  // El panel de la bóveda (no este visor) dibuja el esquema cuando está embebido.
  useEffect(() => {
    if (index) return;
    if (!active) {
      useSharedView.getState().setBody(null);
      return;
    }
    useSharedView.getState().setBody({ id: active.id, content: active.content });
  }, [index, active?.id, active?.content]);

  const patchDoc = (id: string, patch: Partial<PublishedDoc>) => {
    const { content, updatedAt, updatedBy } = patch;
    if (content !== undefined && updatedAt) {
      setTexts((current) => ({ ...current, [id]: { content, updatedAt, updatedBy: updatedBy ?? current[id]?.updatedBy ?? "" } }));
    }
    onChange?.({
      ...tree,
      documents: tree.documents.map((document) => (document.id === id ? { ...document, ...patch } : document)),
    });
  };

  const save = async (base?: number) => {
    if (!active) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await editSharedDoc({
        data: {
          shareId: tree.share.id,
          docId: active.id,
          content: draft,
          baseUpdatedAt: base ?? Date.parse(active.updatedAt),
          // Lo que había al empezar: con ello el servidor junta los cambios de otra persona.
          ...(base === undefined ? { baseContent: active.content } : {}),
        },
      });
      if (result.ok) {
        setConflict(null);
        patchDoc(active.id, {
          title: result.title,
          content: result.content,
          updatedAt: new Date(result.updatedAt).toISOString(),
          updatedBy: result.updatedBy,
        });
        // Se juntó con lo que otra persona guardó entre medias: seguir desde ahí.
        if (result.merged) setDraft(result.content);
        setMessage(result.merged ? t("Guardado junto con los cambios de otra persona") : t("Guardado"));
      } else if ("conflict" in result && result.conflict) {
        setConflict(result.current);
      } else {
        setMessage(result.error);
      }
    } catch {
      setMessage(t("No se pudo guardar."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {single ? null : (
        <nav
          aria-label={t("Contenido compartido")}
          className="max-h-56 shrink-0 overflow-y-auto border-b border-line bg-surface p-2 md:max-h-none md:w-72 md:border-r md:border-b-0"
        >
          <Branch tree={tree} parentId={rootParent(tree)} depth={0} activeId={active?.id ?? null} onOpen={setActiveId} />
          {ordered.length === 0 ? <p className="px-3 py-2 text-sm text-muted">{t("Todavía no hay documentos publicados.")}</p> : null}
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted sm:px-5">
          <Badge className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">
            {active ? <span className="font-medium text-fg">{active.title} · </span> : null}
            {t("Compartido por")}{" "}{tree.share.ownerName} · {level === "admin" ? t("Administrador") : level === "edit" ? t("Puedes editar") : t("Solo lectura")}
            {active ? ` · ${active.updatedBy || tree.share.ownerName} · ${formatDate(active.updatedAt)}` : ""}
          </span>
          {message ? <span className={message.startsWith(t("Guardado")) ? "text-muted" : "text-danger"}>{t(message)}</span> : null}
          {index && canComment ? (
            <button
              type="button"
              aria-pressed={commentsOpen}
              aria-label={t("Comentarios")}
              title={t("Comentarios")}
              onClick={() => setCommentsOpen((value) => !value)}
              className={`inline-flex h-9 items-center gap-1 rounded-md px-2 ${commentsOpen ? "text-accent" : "text-muted hover:text-fg"}`}
            >
              <MessageSquare className="size-4" />
              {commentCount > 0 ? <span className="text-xs">{commentCount}</span> : null}
            </button>
          ) : null}
          {canAdd ? (
            <>
              <button
                type="button"
                disabled={adding}
                aria-label={t("Nueva nota en {0}", { 0: hereName })}
                title={t("Nueva nota en {0}", { 0: hereName })}
                onClick={() => void addNote()}
                className="grid size-9 place-items-center rounded-md text-muted hover:text-fg disabled:opacity-50"
              >
                <FilePlus className="size-4" />
              </button>
              <button
                type="button"
                disabled={adding}
                aria-label={t("Nuevo portafolio en {0}", { 0: hereName })}
                title={t("Nuevo portafolio en {0}", { 0: hereName })}
                onClick={() => setNaming("")}
                className="grid size-9 place-items-center rounded-md text-muted hover:text-fg disabled:opacity-50"
              >
                <FolderPlus className="size-4" />
              </button>
              <label
                aria-label={t("Subir archivo a {0}", { 0: hereName })}
                title={t("Subir archivo a {0}", { 0: hereName })}
                className={`grid size-9 cursor-pointer place-items-center rounded-md text-muted hover:text-fg ${adding ? "pointer-events-none opacity-50" : ""}`}
              >
                <Upload className="size-4" />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files?.length) void addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
              <label
                aria-label={t("Subir carpeta a {0}", { 0: hereName })}
                title={t("Subir carpeta a {0}", { 0: hereName })}
                className={`grid size-9 cursor-pointer place-items-center rounded-md text-muted hover:text-fg ${adding ? "pointer-events-none opacity-50" : ""}`}
              >
                <FolderUp className="size-4" />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  ref={(node) => {
                    node?.setAttribute("webkitdirectory", "");
                    node?.setAttribute("directory", "");
                  }}
                  onChange={(event) => {
                    if (event.target.files?.length) void addFolder(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            </>
          ) : null}
          {canAdd && active ? (
            <button
              type="button"
              aria-label={t("Eliminar")}
              title={t("Eliminar")}
              onClick={() => setDeleting(true)}
              className="grid size-9 place-items-center rounded-md text-muted hover:text-danger"
            >
              <Trash2 className="size-4" />
            </button>
          ) : null}
          {showSpace ? (
            <button
              type="button"
              aria-label={t("Espacio y permisos")}
              title={t("Espacio y permisos")}
              onClick={() => useVault.getState().setDialog({ type: "space", portfolioId: here, shareId: tree.share.id })}
              className="grid size-9 place-items-center rounded-md text-muted hover:text-fg"
            >
              <HardDrive className="size-4" />
            </button>
          ) : null}
          {graphable ? (
            <button
              type="button"
              aria-pressed={showGraph}
              aria-label={t("Grafo")}
              title={t("Grafo")}
              onClick={() => setView((value) => (value === "graph" ? "doc" : "graph"))}
              className={`grid size-9 place-items-center rounded-md ${showGraph ? "text-accent" : "text-muted hover:text-fg"}`}
            >
              <Waypoints className="size-4" />
            </button>
          ) : null}
          {index && active && !showGraph ? (
            <button
              type="button"
              aria-pressed={contextOpen}
              aria-label={t("Esquema y vínculos")}
              title={t("Esquema y vínculos")}
              onClick={() => setContextOpen((value) => !value)}
              className={`grid size-9 place-items-center rounded-md ${contextOpen ? "text-accent" : "text-muted hover:text-fg"}`}
            >
              <ListTree className="size-4" />
            </button>
          ) : null}
          <FullscreenButton className="h-9 w-9" />
          {canEdit ? (
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={t("Historial")}
                title={t("Historial")}
                onClick={() => setHistory(true)}
                className="grid size-9 place-items-center rounded-md text-muted hover:text-fg"
              >
                <History className="size-4" />
              </button>
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setConflict(null);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:text-fg"
                  >
                    <BookOpen className="size-4" />
                    {dirty ? t("Descartar") : t("Leer")}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                    className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
                  >
                    {saving ? t("Guardando…") : t("Guardar")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(active?.content ?? "");
                    setMessage("");
                    setEditing(true);
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:text-fg"
                >
                  <PenLine className="size-4" />
                  {t("Editar")}
                </button>
              )}
            </span>
          ) : null}
        </div>
        {active && !tree.share.token ? <SignatureBar docId={active.id} shareId={tree.share.id} /> : null}
        {deleting && active ? (
          <Modal title={t("Eliminar «{0}»", { 0: active.title })} onClose={() => setDeleting(false)}>
            <p className="text-sm text-muted">{t("Irá a la papelera de su dueño (en un espacio de trabajo, la de sus administradores), que puede recuperarlo.")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleting(false)} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated">
                {t("Cancelar")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleting(false);
                  void deleteFromShared(tree.share.id, active.id).then((error) => {
                    if (error) setMessage(error);
                  });
                }}
                className="h-11 rounded-md bg-danger px-4 text-sm font-medium text-accent-fg"
              >
                {t("Eliminar")}
              </button>
            </div>
          </Modal>
        ) : null}
        {naming !== null ? (
          <Modal title={t("Nuevo portafolio en {0}", { 0: hereName })} onClose={() => setNaming(null)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (naming.trim()) void addPortfolio(naming.trim());
              }}
            >
              <input
                autoFocus
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                maxLength={120}
                aria-label={t("Nombre del portafolio")}
                className="h-11 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setNaming(null)} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated">
                  {t("Cancelar")}
                </button>
                <button
                  type="submit"
                  disabled={!naming.trim() || adding}
                  className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
                >
                  {t("Crear")}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
        <EditingNow names={editors} />
        {conflict && active ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm sm:px-5">
            <span className="min-w-0 flex-1">
              {conflict.updatedBy || tree.share.ownerName}{" "}{t("cambió la nota mientras la editabas.")}
            </span>
            <button
              type="button"
              onClick={() => {
                patchDoc(active.id, {
                  content: conflict.content,
                  updatedAt: new Date(conflict.updatedAt).toISOString(),
                  updatedBy: conflict.updatedBy,
                });
                setDraft(conflict.content);
                setConflict(null);
              }}
              className="h-9 rounded-md px-3 text-sm text-fg hover:bg-elevated"
            >
              {t("Usar la suya")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(conflict.updatedAt)}
              className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {t("Guardar la mía")}
            </button>
          </div>
        ) : null}
        {history && active ? (
          <HistoryDialog
            docId={active.id}
            shareId={tree.share.id}
            canRestore={canEdit}
            onRestored={(result) => {
              patchDoc(active.id, {
                title: result.title,
                content: result.content,
                updatedAt: new Date(result.updatedAt).toISOString(),
              });
              setEditing(false);
            }}
            onClose={() => setHistory(false)}
          />
        ) : null}
        {showGraph ? (
          <div data-ui="shared-graph" className="min-h-0 flex-1">
            <GraphView
              onOpenNote={openDoc}
              source={{ documents, portfolios: tree.portfolios, activeId: active?.id ?? null, onSelect: setActiveId }}
            />
          </div>
        ) : board && here && onOpenPortfolio ? (
          <SharedBoard tree={tree} portfolioId={here} rootId={sharedRoot} onOpenPortfolio={onOpenPortfolio} onOpenDoc={openDoc} />
        ) : !active ? (
          <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">
            {tree.share.kind === "portfolio"
              ? t("Este portafolio está vacío.")
              : t("El contenido todavía no está disponible. Vuelve a intentarlo en unos segundos.")}
          </p>
        ) : active.kind === "file" && active.file ? (
          <FileView
            title={active.title}
            file={active.file}
            docId={active.id}
            links={active.file}
            shareId={onChange ? tree.share.id : undefined}
            canEdit={writable && Boolean(onChange)}
          />
        ) : missing ? (
          <p className="grid flex-1 place-items-center px-6 text-sm text-muted">{t("Este documento ya no está.")}</p>
        ) : loading ? (
          <p className="grid flex-1 place-items-center px-6 text-sm text-muted">{t("Cargando…")}</p>
        ) : editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (dirty && !saving) void save();
              }
            }}
            aria-label={t("Editar {0}", { 0: active.title })}
            spellCheck
            className="min-h-0 w-full flex-1 resize-none bg-bg px-4 py-4 font-mono text-sm leading-6 text-fg outline-none sm:px-8"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MarkdownView
              source={active.content}
              title={active.title}
              noteExists={(name) => Boolean(byTitle(name))}
              onWiki={(name) => {
                const target = byTitle(name);
                if (target) setActiveId(target.id);
              }}
              onTag={() => undefined}
            />
          </div>
        )}
      </div>
      {index && active && !showGraph && (contextOpen || (canComment && commentsOpen)) ? (
        <aside
          aria-label={t("Esquema y vínculos")}
          className="max-h-[45vh] shrink-0 space-y-5 overflow-y-auto border-t border-line bg-surface p-3 md:max-h-none md:w-80 md:border-t-0 md:border-l"
        >
          {contextOpen ? (
            <SharedContext
              document={{ ...(documents.find((item) => item.id === active.id) ?? documents[0]!), content: active.content }}
              documents={documents}
              onOpen={openDoc}
            />
          ) : null}
          {canComment && commentsOpen ? (
            <section>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
                <MessageSquare className="size-3.5" />
                {t("Comentarios")}
              </p>
              <Comments docId={active.id} shareId={tree.share.id} onCount={setCommentCount} />
            </section>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function Branch({
  tree,
  parentId,
  depth,
  activeId,
  onOpen,
}: {
  tree: SharedTree;
  parentId: string | null;
  depth: number;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <ul>
      {childrenOf(tree, parentId).map((portfolio) => (
        <li key={portfolio.id}>
          <p className="flex h-9 items-center gap-1.5 text-sm font-medium text-fg" style={{ paddingLeft: depth * 12 }}>
            <ChevronRight className="size-3.5 rotate-90 text-faint" />
            <FolderOpen className="size-3.5 text-faint" />
            <span className="truncate">{portfolio.name}</span>
          </p>
          <ul>
            {docsIn(tree, portfolio.id).map((document) => {
              const Icon = document.kind === "file" ? File : FileText;
              const on = document.id === activeId;
              return (
                <li key={document.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(document.id)}
                    aria-current={on ? "page" : undefined}
                    className={`flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm ${
                      on ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                    }`}
                    style={{ paddingLeft: depth * 12 + 28 }}
                  >
                    <Icon className={`size-3.5 shrink-0 ${on ? "text-accent" : "text-faint"}`} />
                    <span className="truncate">{document.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Branch tree={tree} parentId={portfolio.id} depth={depth + 1} activeId={activeId} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}
