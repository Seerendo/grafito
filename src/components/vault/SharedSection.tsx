import { Building2, ChevronRight, File, FileText, Folder, FolderOpen, Pencil, Sheet, Users } from "lucide-react";
import { isTableName } from "@/domain/vault/table";
import { useEffect, useRef, useState } from "react";
import { useSharedView } from "@/app/shared-view";
import { deleteFromShared, newSharedNote, newSharedTable, pickAndUpload, report } from "@/app/shared-actions";
import { useVault } from "@/app/vault/store";
import { useContextMenu } from "@/components/ui/use-context-menu";
import type { ContextItem } from "@/components/ui/ContextMenu";
import { childrenOf, docsIn, rootParent } from "@/components/share/shared-tree";
import { sharedExpandKeys } from "@/domain/vault/nav";
import { sharedWithMe } from "@/server/share.functions";
import { fetchSharedTree } from "@/app/shared-open";
import type { SharedTree } from "@/server/share";
import { t } from "@/app/i18n";

/**
 * «Compartidos conmigo» como segunda raíz del directorio: lo que otros
 * usuarios u organizaciones me dejaron ver, en solo lectura. Los portafolios
 * se despliegan aquí mismo y los documentos se abren en el área principal.
 * Con `workspaces`, la raíz «Espacios de trabajo»: los de mis organizaciones
 * (que también llegan como compartidos; ver `server/workspace.ts`).
 */

type Inbox = Awaited<ReturnType<typeof sharedWithMe>>;

const OPEN_KEY = "grafito.shared-open";
const WORKSPACES_OPEN_KEY = "grafito.workspaces-open";
const PAD = ["pl-1", "pl-5", "pl-9", "pl-12"] as const;
/** Lo compartido leído hace menos de esto no se vuelve a leer al abrir algo. */
const FRESH_MS = 30_000;

/**
 * Lo último leído, para que al volver a la bóveda (desde la administración,
 * por ejemplo) las secciones salgan ya como estaban, sin aparecer y
 * desaparecer mientras se vuelve a leer. Solo vale para la misma cuenta.
 */
let lastInbox: { owner: string | null; inbox: Inbox } | null = null;

function storedOpen(key: string, workspaces: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    // Los espacios de trabajo salen desplegados hasta que se pliegan.
    return value === "1" || (workspaces && value === null);
  } catch {
    return false;
  }
}

export function SharedSection({ onOpen, workspaces = false }: { onOpen: () => void; workspaces?: boolean }) {
  const openKey = workspaces ? WORKSPACES_OPEN_KEY : OPEN_KEY;
  const [open, setOpen] = useState(() => storedOpen(openKey, workspaces));
  const [all, setItems] = useState<Inbox | null>(() =>
    lastInbox && lastInbox.owner === useVault.getState().owner ? lastInbox.inbox : null,
  );
  const items = all ? all.filter((item) => Boolean(item.workspace) === workspaces) : null;
  const [failed, setFailed] = useState(false);
  const [trees, setTrees] = useState<Record<string, SharedTree | null>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeDoc = useSharedView((state) => state.docId);
  const showShared = useSharedView((state) => state.openShared);
  const showPortfolio = useSharedView((state) => state.openSharedPortfolio);
  // La página abierta (sin documento): el compartido o uno de sus portafolios.
  const boardShare = useSharedView((state) => (state.tree && !state.docId ? state.tree.share.id : null));
  const boardPortfolio = useSharedView((state) => state.portfolioId);
  const menu = useContextMenu();

  /**
   * Clic derecho en lo compartido (abrir ya es un clic): con permiso de
   * edición en un portafolio, añadir aquí o eliminar (a la papelera de su dueño, que en un
   * espacio de trabajo ven sus administradores).
   */
  const menuFor = (item: NonNullable<Inbox>[number], tree: SharedTree | null | undefined, target: { kind: "portfolio" | "doc"; id: string | null }): ContextItem[] => {
    const writable = item.kind === "portfolio" && (item.access === "edit" || item.access === "admin");
    if (target.kind === "doc" && target.id) {
      const docId = target.id;
      return [
        ...(writable
          ? [{ label: t("Eliminar"), danger: true, onClick: () => void deleteFromShared(item.id, docId).then(report) }]
          : []),
      ];
    }
    const here = target.id;
    return [
      ...(writable
        ? [
            { label: t("Nueva nota"), onClick: () => void newSharedNote(item.id, here).then((error) => (error ? report(error) : onOpen())) },
            { label: t("Nueva tabla"), onClick: () => void newSharedTable(item.id, here).then((error) => (error ? report(error) : onOpen())) },
            {
              label: t("Nuevo portafolio"),
              onClick: () => useVault.getState().setDialog({ type: "shared-portfolio", shareId: item.id, parentId: here }),
            },
            { label: t("Subir archivo"), onClick: () => pickAndUpload(item.id, here) },
          ]
        : []),
      ...(item.kind === "portfolio" && here
        ? [
            {
              label: t("Espacio y permisos…"),
              onClick: () => useVault.getState().setDialog({ type: "space", portfolioId: here, shareId: item.id }),
            },
          ]
        : []),
      ...(writable && here && tree && here !== (childrenOf(tree, rootParent(tree))[0]?.id ?? null)
        ? [
            {
              label: t("Eliminar"),
              danger: true,
              onClick: () =>
                useVault.getState().setDialog({
                  type: "delete-portfolio",
                  id: here,
                  shareId: item.id,
                  name: tree.portfolios.find((portfolio) => portfolio.id === here)?.name,
                }),
            },
          ]
        : []),
    ];
  };

  const refresh = () =>
    sharedWithMe()
      .then((next) => {
        lastInbox = { owner: useVault.getState().owner, inbox: next };
        setItems(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));

  useEffect(() => {
    const stored = storedOpen(openKey, workspaces);
    setOpen(stored);
    // Los espacios de trabajo se leen siempre: sin ninguno, la sección no sale.
    if (stored || workspaces) void refresh();
  }, [openKey, workspaces]);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(openKey, next ? "1" : "0");
    } catch {
      /* solo es una preferencia */
    }
    if (next) void refresh();
  };

  // Lo que se añade desde el visor (nota o archivo nuevos) también se ve aquí.
  const viewed = useSharedView((state) => state.tree);
  useEffect(() => {
    if (viewed) setTrees((current) => (viewed.share.id in current ? { ...current, [viewed.share.id]: viewed } : current));
  }, [viewed]);

  // Cuándo se leyó cada uno: al abrir algo se vuelve a leer solo si pasó
  // `FRESH_MS` (el texto de cada nota se pide siempre al abrirla).
  const readAt = useRef(new Map<string, number>());
  const loadTree = async (shareId: string, fresh = false): Promise<SharedTree | null> => {
    const recent = Date.now() - (readAt.current.get(shareId) ?? 0) < FRESH_MS;
    if (trees[shareId] !== undefined && (!fresh || recent)) return trees[shareId];
    const tree = await fetchSharedTree(shareId).catch(() => null);
    readAt.current.set(shareId, Date.now());
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

  // Al abrir un archivo o un portafolio (desde el visor, la página o una
  // búsqueda), se despliega su camino aquí y la fila entra en la vista. Solo
  // cuando cambia el destino: refrescar el árbol o plegar a mano no vuelve a
  // abrir la sección ni mueve el scroll.
  const target = `${viewed?.share.id ?? ""}:${activeDoc ?? ""}:${boardPortfolio ?? ""}`;
  const expandedTo = useRef("");
  const scrolled = useRef("");
  useEffect(() => {
    if (!viewed) {
      expandedTo.current = "";
      return;
    }
    if (!items || !items.some((item) => item.id === viewed.share.id)) return;
    if (expandedTo.current === target) return;
    expandedTo.current = target;
    const doc = activeDoc ? viewed.documents.find((document) => document.id === activeDoc) : undefined;
    const portfolioId = doc ? doc.portfolioId : boardPortfolio;
    const keys = sharedExpandKeys({
      shareId: viewed.share.id,
      portfolios: viewed.portfolios,
      rootId: childrenOf(viewed, rootParent(viewed))[0]?.id ?? null,
      portfolioId,
    });
    setOpen(true);
    try {
      localStorage.setItem(openKey, "1");
    } catch {
      /* preferencia */
    }
    setTrees((current) => (current[viewed.share.id] === viewed ? current : { ...current, [viewed.share.id]: viewed }));
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (const key of keys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [target, viewed, items, activeDoc, boardPortfolio, openKey]);

  const sharedRootId = viewed ? (childrenOf(viewed, rootParent(viewed))[0]?.id ?? null) : null;
  const reveal = activeDoc
    ? `shared-doc:${activeDoc}`
    : boardShare && (!boardPortfolio || boardPortfolio === sharedRootId)
      ? `shared-share:${boardShare}`
      : boardPortfolio
        ? `shared-port:${boardPortfolio}`
        : null;
  const revealReady = Boolean(viewed && trees[viewed.share.id]);
  useEffect(() => {
    if (!reveal || !open) {
      if (!reveal) scrolled.current = "";
      return;
    }
    if (!items?.some((item) => item.id === (viewed?.share.id ?? ""))) return;
    if (scrolled.current === reveal) return;
    const row = document.querySelector(`[data-ui="sidebar"] [data-reveal="${CSS.escape(reveal)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    scrolled.current = reveal;
  }, [reveal, open, expanded, revealReady, items, viewed]);

  // Se vuelve a leer al abrir (si no es reciente): otra persona con permiso de edición pudo cambiarlo.
  const openDoc = async (shareId: string, docId: string) => {
    const tree = await loadTree(shareId, true);
    if (!tree?.documents.some((document) => document.id === docId)) return;
    showShared(tree, docId);
    onOpen();
  };

  // Hasta saber si hay alguno (o si no hay), la sección de espacios no sale.
  if (workspaces && (!items || items.length === 0)) return null;

  return (
    <div className="mt-1" onDragOver={(event) => event.stopPropagation()} onDrop={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex h-10 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm text-muted hover:bg-elevated hover:text-fg"
      >
        {workspaces ? <Building2 className="size-4 shrink-0 text-faint" /> : <Users className="size-4 shrink-0 text-faint" />}
        <span className="truncate font-medium">{workspaces ? t("Espacios de trabajo") : t("Compartidos conmigo")}</span>
        <ChevronRight className={`ml-auto size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? (
        <ul>
          {failed ? <li className="px-3 py-2 text-xs text-danger">{t("No se pudo leer lo compartido.")}</li> : null}
          {!items && !failed ? <li className="px-3 py-2 text-xs text-faint">{t("Cargando…")}</li> : null}
          {items && items.length === 0 && !workspaces ? (
            <li className="px-3 py-2 text-xs text-faint">{t("Nadie ha compartido nada contigo todavía.")}</li>
          ) : null}
          {items?.map((item) => {
            const tree = trees[item.id];
            const isOpen = expanded.has(item.id);
            const portfolio = item.kind === "portfolio";
            const single = !portfolio && tree ? tree.documents[0] : undefined;
            const rootId = tree ? (childrenOf(tree, rootParent(tree))[0]?.id ?? null) : null;
            const lit =
              (single && single.id === activeDoc) ||
              (portfolio && boardShare === item.id && (boardPortfolio === null || boardPortfolio === rootId));
            const editable = item.access === "edit" || item.access === "admin";
            const rootMenu = async (event: React.MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              const { clientX, clientY } = event;
              const loaded = tree ?? (await loadTree(item.id));
              const root = loaded ? (childrenOf(loaded, rootParent(loaded))[0]?.id ?? null) : null;
              const target = portfolio ? { kind: "portfolio" as const, id: root } : { kind: "doc" as const, id: loaded?.documents[0]?.id ?? null };
              menu.openAt(clientX, clientY, menuFor(item, loaded, target));
            };
            return (
              <li key={item.id}>
                {portfolio ? (
                  // Como un portafolio de la Carpeta Personal: la flecha pliega o
                  // despliega; el nombre abre su página.
                  <div
                    title={t("De {0}", { 0: item.ownerName })}
                    onContextMenu={rootMenu}
                    data-reveal={`shared-share:${item.id}`}
                    data-row={lit ? "marked" : ""}
                    className={`relative flex h-9 shrink-0 items-center rounded-md ${PAD[0]} ${lit ? "bg-inset" : "hover:bg-elevated"}`}
                  >
                    {lit ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
                    <button
                      type="button"
                      aria-label={isOpen ? t("Cerrar {0}", { 0: item.title }) : t("Abrir {0}", { 0: item.title })}
                      data-keep-pick
                      onClick={() => {
                        if (!isOpen) void loadTree(item.id);
                        toggle(item.id);
                      }}
                      className="grid h-9 w-7 shrink-0 place-items-center text-faint hover:text-fg"
                    >
                      <ChevronRight className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        // Su página: sus portafolios, documentos y recientes.
                        const loaded = await loadTree(item.id, true);
                        if (loaded) {
                          showPortfolio(loaded, null);
                          onOpen();
                        }
                      }}
                      aria-current={lit ? "page" : undefined}
                      className="flex h-9 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-sm font-medium text-fg"
                    >
                      {isOpen ? (
                        <FolderOpen className={`size-3.5 shrink-0 ${lit ? "text-accent" : "text-faint"}`} />
                      ) : (
                        <Folder className={`size-3.5 shrink-0 ${lit ? "text-accent" : "text-faint"}`} />
                      )}
                      <span className="truncate">{item.title || t("Sin título")}</span>
                      {editable ? <Pencil className="size-3 shrink-0 text-faint" aria-label={t("Puedes editar")} /> : null}
                      {workspaces ? null : (
                        <span className="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-xs font-normal text-faint">{item.ownerName}</span>
                      )}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    title={t("De {0}", { 0: item.ownerName })}
                    data-reveal={single ? `shared-doc:${single.id}` : undefined}
                    onContextMenu={rootMenu}
                    onClick={async () => {
                      const loaded = await loadTree(item.id);
                      const doc = loaded?.documents[0];
                      if (doc) await openDoc(item.id, doc.id);
                    }}
                    aria-current={lit ? "page" : undefined}
                    className={`relative flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm ${PAD[0]} ${
                      lit ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                    }`}
                  >
                    {lit ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
                    <FileText className={`size-3.5 shrink-0 ${lit ? "text-accent" : "text-faint"}`} />
                    <span className="truncate">{item.title || t("Sin título")}</span>
                    {editable ? <Pencil className="size-3 shrink-0 text-faint" aria-label={t("Puedes editar")} /> : null}
                    {workspaces ? null : (
                      <span className="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-xs text-faint">{item.ownerName}</span>
                    )}
                  </button>
                )}
                {portfolio && isOpen ? (
                  tree === undefined ? (
                    <p className="py-1 pl-10 text-xs text-faint">{t("Cargando…")}</p>
                  ) : tree === null ? (
                    <p className="py-1 pl-10 text-xs text-danger">{t("Ya no está compartido contigo.")}</p>
                  ) : (
                    <SharedBranch
                      tree={tree}
                      parentId={rootParent(tree)}
                      depth={1}
                      skipRoot
                      expanded={expanded}
                      activeDoc={activeDoc}
                      litPortfolio={boardShare === item.id ? boardPortfolio : null}
                      onToggle={toggle}
                      onOpenDoc={(docId) => void openDoc(item.id, docId)}
                      onOpenPortfolio={(id) => {
                        showPortfolio(tree, id);
                        onOpen();
                      }}
                      onMenu={(event, target) => menu.open(event, menuFor(item, tree, target))}
                    />
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {menu.element}
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
  litPortfolio,
  onToggle,
  onOpenDoc,
  onOpenPortfolio,
  onMenu,
}: {
  tree: SharedTree;
  parentId: string | null;
  depth: number;
  skipRoot?: boolean;
  expanded: Set<string>;
  activeDoc: string | null;
  litPortfolio: string | null;
  onToggle: (key: string) => void;
  onOpenDoc: (docId: string) => void;
  onOpenPortfolio: (id: string) => void;
  onMenu: (event: React.MouseEvent, target: { kind: "portfolio" | "doc"; id: string }) => void;
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
            litPortfolio={litPortfolio}
            onToggle={onToggle}
            onOpenDoc={onOpenDoc}
            onOpenPortfolio={onOpenPortfolio}
            onMenu={onMenu}
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
        const lit = litPortfolio === portfolio.id;
        return (
          <li key={portfolio.id}>
            <div
              onContextMenu={(event) => onMenu(event, { kind: "portfolio", id: portfolio.id })}
              data-reveal={`shared-port:${portfolio.id}`}
              data-row={lit ? "marked" : ""}
              className={`relative flex h-9 shrink-0 items-center rounded-md ${pad} ${lit ? "bg-inset" : "hover:bg-elevated"}`}
            >
              {lit ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
              <button
                type="button"
                aria-label={isOpen ? t("Cerrar {0}", { 0: portfolio.name }) : t("Abrir {0}", { 0: portfolio.name })}
                data-keep-pick
                onClick={() => onToggle(key)}
                className="grid h-9 w-7 shrink-0 place-items-center text-faint hover:text-fg"
              >
                <ChevronRight className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => onOpenPortfolio(portfolio.id)}
                aria-current={lit ? "page" : undefined}
                className="flex h-9 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-sm font-medium text-fg"
              >
                {isOpen ? (
                  <FolderOpen className={`size-3.5 shrink-0 ${lit ? "text-accent" : "text-faint"}`} />
                ) : (
                  <Folder className={`size-3.5 shrink-0 ${lit ? "text-accent" : "text-faint"}`} />
                )}
                <span className="truncate">{portfolio.name}</span>
              </button>
            </div>
            {isOpen ? (
              <SharedBranch
                tree={tree}
                parentId={portfolio.id}
                depth={depth + 1}
                expanded={expanded}
                activeDoc={activeDoc}
                litPortfolio={litPortfolio}
                onToggle={onToggle}
                onOpenDoc={onOpenDoc}
                onOpenPortfolio={onOpenPortfolio}
                onMenu={onMenu}
              />
            ) : null}
          </li>
        );
      })}
      {parentId
        ? docsIn(tree, parentId).map((document) => {
            const Icon = document.kind === "file" ? (isTableName(document.file?.name ?? "") ? Sheet : File) : FileText;
            const on = document.id === activeDoc;
            return (
              <li key={document.id}>
                <button
                  type="button"
                  data-reveal={`shared-doc:${document.id}`}
                  onClick={() => onOpenDoc(document.id)}
                  onContextMenu={(event) => onMenu(event, { kind: "doc", id: document.id })}
                  aria-current={on ? "page" : undefined}
                  className={`relative flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm ${pad} ${
                    on ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                  }`}
                >
                  {on ? <span className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" /> : null}
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
