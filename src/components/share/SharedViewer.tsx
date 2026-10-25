import { ChevronRight, File, FileText, FolderOpen, Globe, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { FileView } from "@/components/vault/FileView";
import { MarkdownView } from "@/components/vault/MarkdownView";
import type { SharedTree } from "@/server/share";
import { childrenOf, docsIn, orderDocuments, rootParent } from "./shared-tree";

/**
 * Vista de solo lectura de una nota o un portafolio compartido: índice a la
 * izquierda (o arriba en móvil) y el documento elegido. Sin edición. Dentro
 * de la bóveda el índice lo pone el directorio (`index={false}`) y el
 * documento abierto llega por `docId`/`onOpenDoc`.
 */
export function SharedViewer({
  tree,
  docId,
  onOpenDoc,
  index = true,
}: {
  tree: SharedTree;
  docId?: string | null;
  onOpenDoc?: (id: string) => void;
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
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-xs text-muted sm:px-5">
          <Badge className="size-3.5 shrink-0 text-faint" />
          <span className="truncate">
            {active ? <span className="font-medium text-fg">{active.title} · </span> : null}
            Compartido por {tree.share.ownerName} · Solo lectura
            {active ? ` · ${active.updatedBy || tree.share.ownerName} · ${formatDate(active.updatedAt)}` : ""}
          </span>
        </div>
        {!active ? (
          <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">
            El contenido todavía no está disponible. Vuelve a intentarlo en unos segundos.
          </p>
        ) : active.kind === "file" && active.file ? (
          <FileView title={active.title} file={active.file} />
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
