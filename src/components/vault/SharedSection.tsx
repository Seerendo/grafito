import { ChevronRight, File, FileText, FolderOpen, Pencil, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useSharedView } from "@/app/shared-view";
import { childrenOf, docsIn, rootParent } from "@/components/share/shared-tree";
import { openShared, sharedWithMe } from "@/server/share.functions";
import type { SharedTree } from "@/server/share";

/**
 * «Compartidos conmigo» como segunda raíz del directorio: lo que otros
 * usuarios u organizaciones me dejaron ver, en solo lectura. Los portafolios
 * se despliegan aquí mismo y los documentos se abren en el área principal.
 */

type Inbox = Awaited<ReturnType<typeof sharedWithMe>>;

const OPEN_KEY = "grafito.shared-open";
const PAD = ["pl-1", "pl-5", "pl-9", "pl-12"] as const;

export function SharedSection({ onOpen }: { onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);
  const [trees, setTrees] = useState<Record<string, SharedTree | null>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeDoc = useSharedView((state) => state.docId);
  const showShared = useSharedView((state) => state.openShared);

  const refresh = () =>
    sharedWithMe()
      .then((next) => {
        setItems(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));

  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      /* sin almacenamiento: queda plegado */
    }
    setOpen(stored);
    if (stored) void refresh();
  }, []);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* solo es una preferencia */
    }
    if (next) void refresh();
  };

  const loadTree = async (shareId: string, fresh = false): Promise<SharedTree | null> => {
    if (!fresh && trees[shareId] !== undefined) return trees[shareId];
    const tree = await openShared({ data: { shareId } }).catch(() => null);
    setTrees((current) => ({ ...current, [shareId]: tree }));
    return tree;
  };

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Se vuelve a leer al abrir: otra persona con permiso de edición pudo cambiarlo.
  const openDoc = async (shareId: string, docId: string) => {
    const tree = await loadTree(shareId, true);
    if (!tree?.documents.some((document) => document.id === docId)) return;
    showShared(tree, docId);
    onOpen();
  };

  return (
    <div className="mt-1" onDragOver={(event) => event.stopPropagation()} onDrop={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex h-10 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm text-muted hover:bg-elevated hover:text-fg"
      >
        <Users className="size-4 shrink-0 text-faint" />
        <span className="truncate font-medium">Compartidos conmigo</span>
        <ChevronRight className={`ml-auto size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? (
        <ul>
          {failed ? <li className="px-3 py-2 text-xs text-danger">No se pudo leer lo compartido.</li> : null}
          {!items && !failed ? <li className="px-3 py-2 text-xs text-faint">Cargando…</li> : null}
          {items && items.length === 0 ? (
            <li className="px-3 py-2 text-xs text-faint">Nadie ha compartido nada contigo todavía.</li>
          ) : null}
          {items?.map((item) => {
            const tree = trees[item.id];
            const isOpen = expanded.has(item.id);
            const portfolio = item.kind === "portfolio";
            const Icon = portfolio ? FolderOpen : FileText;
            const single = !portfolio && tree ? tree.documents[0] : undefined;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  title={`De ${item.ownerName}`}
                  onClick={async () => {
                    if (portfolio) {
                      toggle(item.id);
                      await loadTree(item.id);
                      return;
                    }
                    const loaded = await loadTree(item.id);
                    const doc = loaded?.documents[0];
                    if (doc) await openDoc(item.id, doc.id);
                  }}
                  className={`flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm ${PAD[0]} ${
                    single && single.id === activeDoc ? "bg-inset text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                  }`}
                >
                  {portfolio ? (
                    <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <Icon className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{item.title || "Sin título"}</span>
                  {item.access === "edit" ? (
                    <Pencil className="size-3 shrink-0 text-faint" aria-label="Puedes editar" />
                  ) : null}
                  <span className="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-xs text-faint">{item.ownerName}</span>
                </button>
                {portfolio && isOpen ? (
                  tree === undefined ? (
                    <p className="py-1 pl-10 text-xs text-faint">Cargando…</p>
                  ) : tree === null ? (
                    <p className="py-1 pl-10 text-xs text-danger">Ya no está compartido contigo.</p>
                  ) : (
                    <SharedBranch
                      tree={tree}
                      parentId={rootParent(tree)}
                      depth={1}
                      skipRoot
                      expanded={expanded}
                      activeDoc={activeDoc}
                      onToggle={toggle}
                      onOpenDoc={(docId) => void openDoc(item.id, docId)}
                    />
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Rama de un portafolio compartido. El primer nivel (el propio portafolio
 * compartido) ya lo dibuja la fila del elemento, así que se salta.
 */
function SharedBranch({
  tree,
  parentId,
  depth,
  skipRoot,
  expanded,
  activeDoc,
  onToggle,
  onOpenDoc,
}: {
  tree: SharedTree;
  parentId: string | null;
  depth: number;
  skipRoot?: boolean;
  expanded: Set<string>;
  activeDoc: string | null;
  onToggle: (key: string) => void;
  onOpenDoc: (docId: string) => void;
}) {
  const pad = PAD[Math.min(depth, PAD.length - 1)];
  const portfolios = childrenOf(tree, parentId);
  if (skipRoot) {
    return (
      <>
        {portfolios.map((root) => (
          <SharedBranch
            key={root.id}
            tree={tree}
            parentId={root.id}
            depth={depth}
            expanded={expanded}
            activeDoc={activeDoc}
            onToggle={onToggle}
            onOpenDoc={onOpenDoc}
          />
        ))}
      </>
    );
  }
  return (
    <ul>
      {portfolios.map((portfolio) => {
        const key = `${tree.share.id}:${portfolio.id}`;
        const isOpen = expanded.has(key);
        return (
          <li key={portfolio.id}>
            <button
              type="button"
              onClick={() => onToggle(key)}
              className={`flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm text-muted hover:bg-elevated hover:text-fg ${pad}`}
            >
              <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
              <FolderOpen className="size-3.5 shrink-0 text-faint" />
              <span className="truncate">{portfolio.name}</span>
            </button>
            {isOpen ? (
              <SharedBranch
                tree={tree}
                parentId={portfolio.id}
                depth={depth + 1}
                expanded={expanded}
                activeDoc={activeDoc}
                onToggle={onToggle}
                onOpenDoc={onOpenDoc}
              />
            ) : null}
          </li>
        );
      })}
      {parentId
        ? docsIn(tree, parentId).map((document) => {
            const Icon = document.kind === "file" ? File : FileText;
            const on = document.id === activeDoc;
            return (
              <li key={document.id}>
                <button
                  type="button"
                  onClick={() => onOpenDoc(document.id)}
                  aria-current={on ? "page" : undefined}
                  className={`relative flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm ${pad} ${
                    on ? "bg-inset text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                  }`}
                >
                  {on ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
                  <span className="size-3.5 shrink-0" />
                  <Icon className={`size-3.5 shrink-0 ${on ? "text-accent" : "text-faint"}`} />
                  <span className="truncate">{document.title}</span>
                </button>
              </li>
            );
          })
        : null}
    </ul>
  );
}
