import { BookOpen, ChevronRight, File, FileText, FolderOpen, Globe, History, PenLine, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FileView } from "@/components/vault/FileView";
import { HistoryDialog } from "@/components/vault/HistoryDialog";
import { MarkdownView } from "@/components/vault/MarkdownView";
import { editSharedDoc } from "@/server/history.functions";
import type { PublishedDoc, SharedTree } from "@/server/share";
import { childrenOf, docsIn, orderDocuments, rootParent } from "./shared-tree";

/**
 * Visor de una nota o un portafolio compartido: índice a la izquierda (o
 * arriba en móvil) y el documento elegido. Dentro de la bóveda el índice lo
 * pone el directorio (`index={false}`) y el documento abierto llega por
 * `docId`/`onOpenDoc`. Con acceso de edición y `onChange`, las notas se pueden
 * editar y ver su historial; al guardar se avisa con el árbol actualizado.
 */
export function SharedViewer({
  tree,
  docId,
  onOpenDoc,
  onChange,
  index = true,
}: {
  tree: SharedTree;
  docId?: string | null;
  onOpenDoc?: (id: string) => void;
  onChange?: (tree: SharedTree) => void;
  index?: boolean;
}) {
  const ordered = useMemo(() => orderDocuments(tree), [tree]);
  const [ownId, setOwnId] = useState<string | null>(ordered[0]?.id ?? null);
  const activeId = docId ?? ownId;
  const setActiveId = onOpenDoc ?? setOwnId;
  const active = ordered.find((document) => document.id === activeId) ?? ordered[0] ?? null;
  const byTitle = (name: string) => ordered.find((document) => document.title.toLowerCase() === name.toLowerCase());
  const single = tree.share.kind === "document" || !index;
  const Badge = tree.share.visibility === "public" ? Globe : Users;
  const canEdit = tree.share.access === "edit" && Boolean(onChange) && active?.kind === "markdown";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState<{ content: string; updatedAt: number; updatedBy: string } | null>(null);
  const [history, setHistory] = useState(false);
  const dirty = editing && active !== null && draft !== active.content;

  useEffect(() => {
    setEditing(false);
    setConflict(null);
    setMessage("");
  }, [active?.id]);

  const patchDoc = (id: string, patch: Partial<PublishedDoc>) => {
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
        setMessage("Guardado");
      } else if ("conflict" in result && result.conflict) {
        setConflict(result.current);
      } else {
        setMessage(result.error);
      }
    } catch {
      setMessage("No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {single ? null : (
        <nav
          aria-label="Contenido compartido"
          className="max-h-56 shrink-0 overflow-y-auto border-b border-line bg-surface p-2 md:max-h-none md:w-72 md:border-r md:border-b-0"
        >
          <Branch tree={tree} parentId={rootParent(tree)} depth={0} activeId={active?.id ?? null} onOpen={setActiveId} />
          {ordered.length === 0 ? <p className="px-3 py-2 text-sm text-muted">Todavía no hay documentos publicados.</p> : null}
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted sm:px-5">
          <Badge className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">
            {active ? <span className="font-medium text-fg">{active.title} · </span> : null}
            Compartido por {tree.share.ownerName} · {tree.share.access === "edit" ? "Puedes editar" : "Solo lectura"}
            {active ? ` · ${active.updatedBy || tree.share.ownerName} · ${formatDate(active.updatedAt)}` : ""}
          </span>
          {message ? <span className={message === "Guardado" ? "text-muted" : "text-danger"}>{message}</span> : null}
          {canEdit ? (
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="Historial"
                title="Historial"
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
                    {dirty ? "Descartar" : "Leer"}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                    className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
                  >
                    {saving ? "Guardando…" : "Guardar"}
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
                  Editar
                </button>
              )}
            </span>
          ) : null}
        </div>
        {conflict && active ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm sm:px-5">
            <span className="min-w-0 flex-1">
              {conflict.updatedBy || tree.share.ownerName} cambió la nota mientras la editabas.
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
              Usar la suya
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(conflict.updatedAt)}
              className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              Guardar la mía
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
        {!active ? (
          <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">
            El contenido todavía no está disponible. Vuelve a intentarlo en unos segundos.
          </p>
        ) : active.kind === "file" && active.file ? (
          <FileView title={active.title} file={active.file} docId={active.id} links={active.file} />
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
            aria-label={`Editar ${active.title}`}
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
  return new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}
