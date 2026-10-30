import { ArrowDownLeft, FileText, Link2, ListTree, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import type { TextAnchor } from "@/domain/vault/anchor";
import { backlinkLine, extractHeadings, extractWikiLinks, findByTitle } from "@/domain/vault/links";
import type { Document, ManualKind, ManualLink } from "@/domain/vault/types";
import { t } from "@/app/i18n";

const KIND_LABEL: Record<ManualKind, string> = { referencia: "Referencia", llama: "Invoca" };

/**
 * Esquema, vínculos y menciones de un documento compartido, para moverse
 * rápido entre lo publicado. Con `onLink`, quien puede editar también vincula
 * notas y archivos de ese espacio (se guardan en la bóveda del dueño).
 */
export function SharedContext({
  document,
  documents,
  portfolios = [],
  onOpen,
  onLink,
  onUnlink,
}: {
  document: Document;
  documents: Document[];
  portfolios?: { id: string; name: string }[];
  onOpen: (id: string, anchor?: TextAnchor) => void;
  onLink?: () => void;
  onUnlink?: (link: ManualLink) => void;
}) {
  const headings = document.kind === "markdown" ? extractHeadings(document.content) : [];
  const outgoing = [
    ...(document.kind === "markdown"
      ? extractWikiLinks(document.content).flatMap((title) => {
          const target = findByTitle(documents, title);
          return target ? [{ id: target.id, title: target.title, label: "Wiki", detail: "" }] : [];
        })
      : []),
    ...document.links.flatMap((link) => {
      const portfolio = link.target === "portfolio" ? portfolios.find((item) => item.id === link.targetId) : undefined;
      const target = portfolio ? undefined : documents.find((item) => item.id === link.targetId);
      const title = portfolio?.name ?? target?.title;
      return title
        ? [
            {
              id: portfolio?.id ?? target!.id,
              title,
              label: KIND_LABEL[link.kind],
              detail: link.anchor ? `${t("pág. {0}", { 0: link.anchor.page })} · «${link.anchor.exact}»` : "",
              link,
            },
          ]
        : [];
    }),
  ];
  const incoming = documents
    .filter((item) => item.id !== document.id)
    .flatMap((item) => {
      const wiki =
        item.kind === "markdown" &&
        extractWikiLinks(item.content).some((title) => title.toLowerCase() === document.title.toLowerCase());
      const manual = item.links.find((link) => link.targetId === document.id);
      if (!wiki && !manual) return [];
      return [
        {
          id: item.id,
          title: item.title,
          detail: wiki ? backlinkLine(item.content, document.title) : manual ? t(KIND_LABEL[manual.kind]) : "",
          anchor: manual?.anchor,
        },
      ];
    });

  const jump = (id: string) =>
    window.document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div data-ui="shared-context" className="space-y-4">
      {document.kind === "markdown" ? (
        <Block title={t("Esquema")} icon={<ListTree className="size-3.5" />} count={headings.length}>
          {headings.length === 0 ? (
            <Empty>{t("Esta nota no tiene encabezados.")}</Empty>
          ) : (
            <ul>
              {headings.map((heading) => (
                <li key={heading.id}>
                  <button
                    type="button"
                    onClick={() => jump(heading.id)}
                    style={{ paddingLeft: `${(Math.min(heading.level, 4) - 1) * 0.75 + 0.375}rem` }}
                    className="block w-full truncate rounded-md py-1.5 pr-1.5 text-left text-sm text-fg hover:bg-elevated"
                  >
                    {heading.text}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Block>
      ) : null}
      <Block title={t("Vínculos")} icon={<Link2 className="size-3.5" />} count={outgoing.length}>
        {onLink ? (
          <button
            type="button"
            onClick={onLink}
            className="mb-1 inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-accent hover:bg-elevated"
          >
            <Plus className="size-3.5" />
            {t("Vincular")}
          </button>
        ) : null}
        {outgoing.length === 0 ? (
          <Empty>{t("Sin vínculos.")}</Empty>
        ) : (
          <ul>
            {outgoing.map((item, index) => (
              <li key={`${item.id}-${index}`} className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <Row
                    onClick={() => onOpen(item.id)}
                    title={item.title}
                    badge={t(item.label)}
                    detail={item.detail}
                  />
                </div>
                {onUnlink && "link" in item && item.link ? (
                  <button
                    type="button"
                    aria-label={t("Quitar vínculo")}
                    onClick={() => onUnlink(item.link)}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-elevated hover:text-fg"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block title={t("Menciones")} icon={<ArrowDownLeft className="size-3.5" />} count={incoming.length}>
        {incoming.length === 0 ? (
          <Empty>{t("Nadie apunta a este documento.")}</Empty>
        ) : (
          <ul>
            {incoming.map((item) => (
              <li key={item.id}>
                <Row onClick={() => onOpen(item.id, item.anchor)} title={item.title} detail={item.detail} />
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}

function Block({ title, icon, count, children }: { title: string; icon: ReactNode; count: number; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
        {icon}
        {title}
        <span className="ml-1 rounded bg-elevated px-1.5 text-[11px] text-faint">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1.5 py-1 text-sm text-faint italic">{children}</p>;
}

function Row({
  onClick,
  title,
  badge,
  detail,
}: {
  onClick: () => void;
  title: string;
  badge?: string;
  detail?: string;
}) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-2 rounded-md px-1.5 py-2 text-left hover:bg-elevated">
      {badge ? (
        <span className="mt-0.5 shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[11px] text-accent">{badge}</span>
      ) : (
        <FileText className="mt-0.5 size-3.5 shrink-0 text-faint" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm text-fg">{title}</span>
        {detail ? <span className="mt-0.5 line-clamp-2 block text-xs text-faint">{detail}</span> : null}
      </span>
    </button>
  );
}
