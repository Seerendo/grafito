import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Hash,
  Link2,
  ListTree,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { backlinkLine, extractHeadings, extractTags, extractWikiLinks, findByTitle } from "@/domain/vault/links";
import type { ManualKind } from "@/domain/vault/types";
import { resolveLink, useSharedTrees } from "@/app/shared-links";
import { useSharedView } from "@/app/shared-view";
import { useActiveDocument, useVault } from "@/app/vault/store";
import { useCan } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import { t } from "@/app/i18n";
import { linkKey } from "@/domain/vault/anchor";
import { asDocuments } from "@/components/share/shared-tree";
import { SharedContext } from "@/components/share/SharedContext";
import { Comments } from "./Comments";

const KIND_LABEL: Record<ManualKind, string> = {
  referencia: "referencia",
  llama: "invoca",
};

type SectionKey = "esquema" | "vinculos" | "escritos" | "menciones" | "comentarios";

type OutlineNode = {
  id: string;
  text: string;
  level: number;
  children: OutlineNode[];
};

function nestHeadings(headings: { id: string; text: string; level: number }[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const heading of headings) {
    const node: OutlineNode = { ...heading, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export function ContextPane({
  onOpenNote,
  onInspect,
  onFilter,
  onCollapse,
  holdGraph,
}: {
  onOpenNote: (id: string) => void;
  onInspect: (id: string) => void;
  onFilter: () => void;
  /** En escritorio, pliega el panel a un riel (`ContextRail`). */
  onCollapse?: () => void;
  holdGraph: boolean;
}) {
  const document = useActiveDocument();
  const sharedTree = useSharedView((state) => state.tree);
  const sharedDocId = useSharedView((state) => state.docId);
  const sharedBody = useSharedView((state) => state.body);
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const trees = useSharedTrees((state) => state.trees);
  const setTag = useVault((state) => state.setTag);
  const openTitle = useVault((state) => state.openTitle);
  const setMode = useVault((state) => state.setMode);
  const setDialog = useVault((state) => state.setDialog);
  const canLink = useCan(PERMISSION.linksManage);
  const removeManualLink = useVault((state) => state.removeManualLink);
  const setFocusAnchor = useVault((state) => state.setFocusAnchor);
  const mode = useVault((state) => state.mode);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    esquema: true,
    vinculos: true,
    escritos: true,
    menciones: true,
    comentarios: true,
  });
  const [commentCount, setCommentCount] = useState(0);
  const [foldedHeads, setFoldedHeads] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setFoldedHeads({});
  }, [document?.id]);

  const toggleSection = (key: SectionKey) => {
    setOpenSections((state) => ({ ...state, [key]: !state[key] }));
  };

  const sharedDoc = sharedTree && sharedDocId ? sharedTree.documents.find((item) => item.id === sharedDocId) : undefined;
  if (sharedTree && sharedDoc) {
    const sharedDocuments = asDocuments(sharedTree.documents).map((item) =>
      sharedBody && item.id === sharedBody.id ? { ...item, content: sharedBody.content, kind: item.kind } : item,
    );
    const opened = sharedDocuments.find((item) => item.id === sharedDoc.id);
    if (opened) {
      return (
        <aside data-ui="context" className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-surface px-3 py-1 md:w-72 md:border-l md:border-line">
          <CollapseButton onCollapse={onCollapse} />
          <SharedContext
            document={opened}
            documents={sharedDocuments}
            onOpen={(id) => {
              const tree = useSharedView.getState().tree;
              if (tree) useSharedView.getState().openShared(tree, id);
            }}
          />
          <section className="border-b border-line py-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
              <MessageSquare className="size-3.5" />
              {t("Comentarios")}
              {commentCount > 0 ? (
                <span className="rounded-full bg-elevated px-1.5 text-[11px] leading-5 text-muted tabular-nums">{commentCount}</span>
              ) : null}
            </p>
            <Comments docId={opened.id} shareId={sharedTree.share.id} onCount={setCommentCount} />
          </section>
        </aside>
      );
    }
  }

  if (!document) {
    return (
      <aside data-ui="context" className="flex h-full flex-col bg-surface text-sm text-faint md:w-72 md:border-l md:border-line">
        <CollapseButton onCollapse={onCollapse} />
        <p className="flex flex-1 items-center justify-center p-6">{t("Sin documento abierto")}</p>
      </aside>
    );
  }

  const headings = document.kind === "markdown" ? extractHeadings(document.content) : [];
  const outline = nestHeadings(headings);
  const outgoingWiki =
    document.kind === "markdown"
      ? extractWikiLinks(document.content).map((title) => ({
          title,
          target: findByTitle(documents, title),
        }))
      : [];
  const manual = document.links.map((link) => ({ link, target: resolveLink(link, documents, portfolios, trees) }));
  const incomingWiki = documents
    .filter((item) => item.id !== document.id && item.kind === "markdown")
    .flatMap((item) => {
      const hit = extractWikiLinks(item.content).some(
        (title) => title.toLowerCase() === document.title.toLowerCase(),
      );
      if (!hit) return [];
      return [{ id: item.id, title: item.title, detail: backlinkLine(item.content, document.title), via: "wiki" as const }];
    });
  const incomingManual = documents
    .filter((item) => item.id !== document.id)
    .flatMap((item) =>
      item.links
        .filter((entry) => entry.targetId === document.id)
        .map((link) => ({
          id: item.id,
          title: item.title,
          // Desde una frase de un PDF: cuál y en qué página.
          detail: link.anchor ? `${t("pág. {0}", { 0: link.anchor.page })} · «${link.anchor.exact}»` : KIND_LABEL[link.kind],
          via: link.kind,
          key: linkKey(link),
          anchor: link.anchor,
        })),
    );
  const tags = document.kind === "markdown" ? extractTags(document.content) : [];

  const jump = (id: string) => {
    if (holdGraph) return;
    if (mode === "edit") setMode("split");
    onOpenNote(document.id);
    requestAnimationFrame(() => {
      const target = window.document.getElementById(id) ?? window.document.getElementById("note-top");
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const choose = (id: string) => {
    if (holdGraph) onInspect(id);
    else onOpenNote(id);
  };

  return (
    <aside data-ui="context" className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-surface px-3 py-1 md:w-72 md:border-l md:border-line">
      <CollapseButton onCollapse={onCollapse} />
      {document.kind === "markdown" ? (
        <Section
          title={t("Esquema")}
          icon={<ListTree className="size-3.5" />}
          count={headings.length}
          fold={{ open: openSections.esquema, onToggle: () => toggleSection("esquema") }}
        >
          {outline.length === 0 ? (
            <Empty>{t("Esta nota no tiene encabezados.")}</Empty>
          ) : (
            <OutlineTree
              nodes={outline}
              folded={foldedHeads}
              onToggle={(id) => setFoldedHeads((state) => ({ ...state, [id]: !state[id] }))}
              onJump={jump}
            />
          )}
        </Section>
      ) : null}

      <Section
        title={t("Vínculos")}
        icon={<Link2 className="size-3.5" />}
        count={manual.length}
        fold={{ open: openSections.vinculos, onToggle: () => toggleSection("vinculos") }}
        action={
          canLink ? (
            <button
              type="button"
              onClick={() => setDialog({ type: "link", sourceId: document.id })}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-accent hover:bg-elevated"
            >
              <Plus className="size-3.5" />
              {t("Vincular")}
            </button>
          ) : null
        }
      >
        {manual.length === 0 ? (
          <Empty>{t("Sin vínculos.")}</Empty>
        ) : (
          <ul>
            {manual.map((item) => (
              <li key={`${item.link.kind}-${linkKey(item.link)}`} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!item.target}
                  onClick={() => (item.target?.open ? item.target.open() : item.target && choose(item.target.id))}
                  onDoubleClick={() => item.target && !item.target.open && onOpenNote(item.target.id)}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-elevated disabled:hover:bg-transparent"
                >
                  <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[11px] text-accent">
                    {KIND_LABEL[item.link.kind]}
                  </span>
                  <span className="min-w-0">
                    <span className={`block truncate ${item.target ? "text-fg" : "text-muted"}`}>
                      {item.target?.title ?? t("destino borrado")}
                    </span>
                    {item.link.anchor ? (
                      <span className="block truncate text-xs text-faint">
                        {t("pág. {0}", { 0: item.link.anchor.page })} · «{item.link.anchor.exact}»
                      </span>
                    ) : null}
                  </span>
                </button>
                {canLink ? (
                  <button
                    type="button"
                    aria-label={t("Quitar vínculo")}
                    onClick={() => removeManualLink(document.id, item.link)}
                    className="grid h-10 w-9 shrink-0 place-items-center rounded-md text-faint hover:bg-elevated hover:text-fg"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {document.kind === "markdown" ? (
        <Section
          title={t("Enlaces en el texto")}
          icon={<ArrowUpRight className="size-3.5" />}
          count={outgoingWiki.length}
          fold={{ open: openSections.escritos, onToggle: () => toggleSection("escritos") }}
        >
          {outgoingWiki.length === 0 ? (
            <Empty>{t("Todavía no hay [[enlaces]] en el texto.")}</Empty>
          ) : (
            <ul>
              {outgoingWiki.map((item) => (
                <li key={item.title}>
                  <button
                    type="button"
                    onClick={() => {
                      if (holdGraph) {
                        if (item.target) choose(item.target.id);
                        return;
                      }
                      openTitle(item.title);
                      if (item.target) onOpenNote(item.target.id);
                    }}
                    onDoubleClick={() => {
                      openTitle(item.title);
                      if (item.target) onOpenNote(item.target.id);
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-elevated"
                  >
                    <FileText className="size-3.5 shrink-0 text-faint" />
                    <span className={`truncate ${item.target ? "text-fg" : "text-muted underline decoration-dashed"}`}>
                      {item.title}
                    </span>
                    {item.target ? null : <span className="ml-auto shrink-0 text-[11px] text-faint">{t("sin crear")}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section
        title={t("Menciones")}
        icon={<ArrowDownLeft className="size-3.5" />}
        count={incomingWiki.length + incomingManual.length}
        fold={{ open: openSections.menciones, onToggle: () => toggleSection("menciones") }}
      >
        {incomingWiki.length + incomingManual.length === 0 ? (
          <Empty>{t("Nadie apunta a este documento.")}</Empty>
        ) : (
          <ul className="space-y-1">
            {[...incomingManual, ...incomingWiki].map((item) => (
              <li key={`${item.via}-${item.id}-${"key" in item ? item.key : ""}`}>
                <button
                  type="button"
                  onClick={() => {
                    // Desde una frase de un PDF: al abrirlo, ir a ella.
                    if ("anchor" in item && item.anchor && !holdGraph) setFocusAnchor({ docId: item.id, anchor: item.anchor });
                    choose(item.id);
                  }}
                  onDoubleClick={() => onOpenNote(item.id)}
                  className="flex w-full items-start gap-2 rounded-md px-1.5 py-2 text-left hover:bg-elevated"
                >
                  <FileText className="mt-0.5 size-3.5 shrink-0 text-faint" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-fg">{item.title}</span>
                    {item.detail ? <span className="mt-0.5 line-clamp-2 block text-xs text-faint">{t(item.detail)}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t("Comentarios")}
        icon={<MessageSquare className="size-3.5" />}
        count={commentCount}
        fold={{ open: openSections.comentarios, onToggle: () => toggleSection("comentarios") }}
      >
        <Comments docId={document.id} onCount={setCommentCount} />
      </Section>

      {document.kind === "markdown" ? (
        <Section title={t("Etiquetas")} icon={<Hash className="size-3.5" />} count={tags.length}>
          {tags.length === 0 ? (
            <Empty>{t("Sin etiquetas. Prueba con #atlas.")}</Empty>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setTag(tag);
                    onFilter();
                  }}
                  className="inline-flex h-8 items-center rounded-full border border-line bg-elevated px-3 text-xs text-accent hover:text-fg"
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </Section>
      ) : null}
    </aside>
  );
}

function OutlineTree({
  nodes,
  folded,
  onToggle,
  onJump,
}: {
  nodes: OutlineNode[];
  folded: Record<string, boolean>;
  onToggle: (id: string) => void;
  onJump: (id: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        const hasKids = node.children.length > 0;
        const open = !folded[node.id];
        return (
          <li key={node.id}>
            <div className="flex items-center" style={{ paddingLeft: `${(node.level - 1) * 0.7}rem` }}>
              {hasKids ? (
                <button
                  type="button"
                  aria-label={open ? t("Replegar {0}", { 0: node.text }) : t("Desplegar {0}", { 0: node.text })}
                  aria-expanded={open}
                  onClick={() => onToggle(node.id)}
                  className="grid h-9 w-7 shrink-0 place-items-center text-faint hover:text-fg"
                >
                  <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
                </button>
              ) : (
                <span className="w-7 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onJump(node.id)}
                className="flex h-9 min-w-0 flex-1 items-center rounded-md text-left text-sm text-muted hover:bg-elevated hover:text-fg"
              >
                <span className="truncate">{node.text}</span>
              </button>
            </div>
            {hasKids && open ? (
              <OutlineTree nodes={node.children} folded={folded} onToggle={onToggle} onJump={onJump} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Bloque del panel de detalles: cabecera con icono, título, contador y una
 * frase que dice qué contiene, separado del siguiente por una línea.
 */
function Section({
  title,
  icon,
  count,
  action,
  children,
  fold,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  fold?: { open: boolean; onToggle: () => void };
}) {
  const open = !fold || fold.open;
  const heading = (
    <>
      <span className="text-faint">{icon}</span>
      <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</span>
      {count !== undefined ? (
        <span className="ml-1 rounded-full bg-elevated px-1.5 text-[11px] leading-5 text-muted tabular-nums">{count}</span>
      ) : null}
    </>
  );
  return (
    <section className="border-b border-line py-3 last:border-b-0">
      <div className="flex h-8 items-center gap-1">
        {fold ? (
          <button
            type="button"
            aria-expanded={fold.open}
            onClick={fold.onToggle}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left hover:text-fg"
          >
            <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${fold.open ? "rotate-90" : ""}`} />
            {heading}
          </button>
        ) : (
          <h2 className="flex h-8 min-w-0 flex-1 items-center gap-1.5 pl-5">{heading}</h2>
        )}
        {open ? action : null}
      </div>
      {open ? (
        <div className="mt-1 pl-5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted italic">{children}</p>;
}

function CollapseButton({ onCollapse }: { onCollapse?: () => void }) {
  if (!onCollapse) return null;
  return (
    <div className="flex shrink-0 justify-end px-1 pt-2">
      <button
        type="button"
        aria-label={t("Plegar los detalles")}
        title={t("Plegar los detalles")}
        onClick={onCollapse}
        className="grid h-8 w-7 place-items-center rounded-md text-faint hover:text-fg"
      >
        <ChevronsRight className="size-4" />
      </button>
    </div>
  );
}

/** Detalles plegados: un riel estrecho a la derecha con una flecha para desplegarlos. */
export function ContextRail({ onExpand }: { onExpand: () => void }) {
  return (
    <div data-ui="rail" className="flex h-full w-9 shrink-0 flex-col items-center border-l border-line bg-surface pt-2">
      <button
        type="button"
        aria-label={t("Desplegar los detalles")}
        title={t("Desplegar los detalles")}
        onClick={onExpand}
        className="grid h-11 w-7 place-items-center rounded-md text-faint hover:text-fg"
      >
        <ChevronsLeft className="size-4" />
      </button>
    </div>
  );
}

