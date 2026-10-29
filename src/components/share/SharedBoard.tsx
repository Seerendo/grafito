import { ChevronRight, File, FileText, Folder } from "lucide-react";
import { useMemo } from "react";
import type { PublishedDoc, SharedTree } from "@/server/share";
import type { ContextItem } from "@/components/ui/ContextMenu";
import { useContextMenu } from "@/components/ui/use-context-menu";
import { deleteFromShared, newSharedNote, pickAndUpload, report } from "@/app/shared-actions";
import { useVault } from "@/app/vault/store";
import { childrenOf, docsIn } from "./shared-tree";
import { intl, t } from "@/app/i18n";

const RECENT = 12;

/**
 * Página de un portafolio compartido (o de un espacio de trabajo) dentro de la
 * bóveda, como la de la Carpeta Personal: sus portafolios, sus documentos y
 * lo último que se cambió dentro. Encima, la ruta hasta el compartido. Con
 * permiso de edición, el clic derecho añade aquí (o en un portafolio) como en
 * la Carpeta Personal, y en un documento lo elimina.
 */
export function SharedBoard({
  tree,
  portfolioId,
  rootId,
  writable,
  onOpenPortfolio,
  onOpenDoc,
}: {
  tree: SharedTree;
  portfolioId: string;
  rootId: string | null;
  writable: boolean;
  onOpenPortfolio: (id: string) => void;
  onOpenDoc: (id: string) => void;
}) {
  const menu = useContextMenu();
  const shareId = tree.share.id;
  const addHere = (id: string): ContextItem[] => [
    ...(writable
      ? [
          { label: t("Nueva nota"), onClick: () => void newSharedNote(shareId, id).then(report) },
          {
            label: t("Nuevo portafolio"),
            onClick: () => useVault.getState().setDialog({ type: "shared-portfolio", shareId, parentId: id }),
          },
          { label: t("Subir archivo"), onClick: () => pickAndUpload(shareId, id) },
        ]
      : []),
    {
      label: t("Espacio y permisos…"),
      onClick: () => useVault.getState().setDialog({ type: "space", portfolioId: id, shareId }),
    },
  ];
  const byId = useMemo(() => new Map(tree.portfolios.map((portfolio) => [portfolio.id, portfolio])), [tree]);
  const here = byId.get(portfolioId);
  const children = childrenOf(tree, portfolioId);
  const docs = docsIn(tree, portfolioId);

  // Lo que hay dentro (a cualquier profundidad), para contar y para los recientes.
  const inside = useMemo(() => {
    const ids = new Set<string>([portfolioId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const portfolio of tree.portfolios) {
        if (portfolio.parentId && ids.has(portfolio.parentId) && !ids.has(portfolio.id)) {
          ids.add(portfolio.id);
          grew = true;
        }
      }
    }
    return ids;
  }, [tree, portfolioId]);
  const recent = useMemo(
    () =>
      tree.documents
        .filter((document) => document.portfolioId && inside.has(document.portfolioId))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, RECENT),
    [tree, inside],
  );
  const countIn = (id: string) => {
    let count = 0;
    const walk = (parentId: string) => {
      count += tree.documents.filter((document) => document.portfolioId === parentId).length;
      for (const child of childrenOf(tree, parentId)) walk(child.id);
    };
    walk(id);
    return count;
  };

  // Del compartido hasta aquí.
  const trail: { id: string; name: string }[] = [];
  for (let at = here; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
    trail.unshift({ id: at.id, name: at.name });
    if (at.id === rootId) break;
  }

  const docRow = (document: PublishedDoc, place: boolean) => {
    const Icon = document.kind === "file" ? File : FileText;
    return (
      <li key={document.id} className="border-b border-line last:border-b-0">
        <button
          type="button"
          onClick={() => onOpenDoc(document.id)}
          onContextMenu={(event) =>
            menu.open(
              event,
              writable
                ? [{ label: t("Eliminar"), danger: true, onClick: () => void deleteFromShared(shareId, document.id).then(report) }]
                : [],
            )
          }
          className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
        >
          <Icon className="size-4 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
          {place ? (
            <span className="hidden shrink-0 text-xs text-faint sm:inline">
              {(document.portfolioId && byId.get(document.portfolioId)?.name) ?? ""}
            </span>
          ) : null}
          <span className="shrink-0 text-xs text-faint">{formatWhen(document.updatedAt)}</span>
        </button>
      </li>
    );
  };

  return (
    <div data-ui="shared-board" className="min-h-0 flex-1 overflow-y-auto bg-bg px-4 py-8 sm:px-8" onContextMenu={(event) => {
        if (!(event.target as HTMLElement).closest("button")) menu.open(event, addHere(portfolioId));
      }}
    >
      {trail.length > 1 ? (
        <nav aria-label={t("Ruta")} data-menu-skip className="mb-2 flex flex-wrap items-center gap-1 text-xs text-faint">
          {trail.map((step, index) => (
            <span key={step.id} className="flex items-center gap-1">
              {index > 0 ? <ChevronRight className="size-3 shrink-0" /> : null}
              {index < trail.length - 1 ? (
                <button type="button" onClick={() => onOpenPortfolio(step.id)} className="hover:text-fg">
                  {step.name}
                </button>
              ) : (
                <span aria-current="page" className="text-muted">
                  {step.name}
                </span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <h1 className="font-serif text-4xl font-semibold tracking-tight">{here?.name ?? tree.share.title}</h1>
      {children.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Portafolios")}</h2>
          <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
            {children.map((portfolio) => (
              <li key={portfolio.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpenPortfolio(portfolio.id)}
                  onContextMenu={(event) => menu.open(event, addHere(portfolio.id))}
                  className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
                >
                  <Folder className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-sm">{portfolio.name}</span>
                  <span className="shrink-0 text-xs text-faint">{countIn(portfolio.id)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {docs.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Documentos")}</h2>
          <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">{docs.map((document) => docRow(document, false))}</ul>
        </section>
      ) : null}
      {recent.length > 0 && children.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Recientes")}</h2>
          <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">{recent.map((document) => docRow(document, true))}</ul>
        </section>
      ) : null}
      {children.length === 0 && docs.length === 0 ? <p className="mt-6 text-sm text-muted">{t("Este portafolio está vacío.")}</p> : null}
      {menu.element}
    </div>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}
