import { ChevronRight, Download, File, FileText, Folder, GitBranch, HardDrive, Link2, PenTool, Plus, Sheet, X } from "lucide-react";
import { isTableName } from "@/domain/vault/table";
import { resolveLink, useSharedTrees } from "@/app/shared-links";
import { linkKey } from "@/domain/vault/anchor";
import type { Portfolio } from "@/domain/vault/types";
import { usePluginEnabled } from "@/app/plugins";
import { downloadPortfolio } from "@/app/export";
import { usePermissions } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import { createDrawing, createTable } from "./ingest-files";
import { useMemo } from "react";
import { useVault } from "@/app/vault/store";
import { intl, t } from "@/app/i18n";
import { useDirectoryPick } from "@/app/directory-pick";
import { PendingSignatures } from "./SignatureDialog";
import { useRowMenu } from "./RowMenu";

const RECENT = 12;

/** Suma la fila a la selección del directorio sin abrirla. */
function selectInDirectory(target: { kind: "document" | "portfolio"; id: string }) {
  useDirectoryPick.getState().add(target.kind === "document" ? `doc:${target.id}` : `port:${target.id}`);
}

/**
 * Raíz: sus portafolios y lo último que se tocó en la bóveda, con el mismo
 * menú contextual que el directorio.
 */
export function HomeBoard({ onCreate, onOpenNote }: { onCreate?: () => void; onOpenNote: (id: string) => void }) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const setActive = useVault((state) => state.setActive);
  const openPortfolio = useVault((state) => state.openPortfolio);
  const roots = useMemo(
    () =>
      portfolios
        .filter((portfolio) => portfolio.parentId === null)
        .sort((a, b) => a.name.localeCompare(b.name, intl(), { sensitivity: "base" })),
    [portfolios],
  );
  const countIn = (id: string) =>
    documents.filter((document) => document.portfolioId === id).length + portfolios.filter((item) => item.parentId === id).length;
  const { openMenu, element: menu } = useRowMenu(onOpenNote, selectInDirectory);
  const recent = useMemo(
    () => [...documents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT),
    [documents],
  );
  const place = (id: string | null) => portfolios.find((portfolio) => portfolio.id === id)?.name ?? t("Carpeta Personal");

  return (
    <div
      data-home
      className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8"
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        openMenu(event, { kind: "root" });
      }}
    >
      <div className="w-full">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="font-serif text-4xl font-semibold tracking-tight">{t("Carpeta Personal")}</h1>
          <span className="ml-auto flex flex-wrap gap-2">
            <NewTableButton portfolioId={null} onOpenNote={onOpenNote} />
            <NewDrawingButton portfolioId={null} onOpenNote={onOpenNote} />
            {onCreate ? (
              <button
                type="button"
                onClick={onCreate}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
              >
                <Plus className="size-4" />
                {t("Nueva nota")}
              </button>
            ) : null}
          </span>
        </div>
        <div className="mt-8">
          <PendingSignatures onOpenNote={onOpenNote} />
        </div>
        {roots.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Portafolios")}</h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {roots.map((portfolio) => (
                <li key={portfolio.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => openPortfolio(portfolio.id)}
                    onContextMenu={(event) => openMenu(event, { kind: "portfolio", id: portfolio.id })}
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
        {recent.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Recientes")}</h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {recent.map((document) => {
                const Icon = document.kind === "file" ? (isTableName(document.file?.name ?? "") ? Sheet : File) : FileText;
                return (
                  <li key={document.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setActive(document.id)}
                      onContextMenu={(event) => openMenu(event, { kind: "document", id: document.id })}
                      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
                    >
                      <Icon className="size-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
                      <span className="hidden shrink-0 text-xs text-faint sm:inline">{place(document.portfolioId)}</span>
                      <span className="shrink-0 text-xs text-faint">{formatWhen(document.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
      {menu}
    </div>
  );
}

/**
 * Un portafolio abierto desde el directorio: su ruta, sus subportafolios y sus
 * notas y archivos, con el mismo menú contextual que el directorio.
 */
export function PortfolioBoard({
  portfolioId,
  onCreate,
  onOpenNote,
  onOpenPortfolio,
  onHome,
}: {
  portfolioId: string;
  onCreate?: () => void;
  onOpenNote: (id: string) => void;
  onOpenPortfolio: (id: string) => void;
  onHome: () => void;
}) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const setActive = useVault((state) => state.setActive);
  const { openMenu, element: menu } = useRowMenu(onOpenNote, selectInDirectory);
  const portfolio = portfolios.find((item) => item.id === portfolioId);
  const trail = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    let current = portfolio;
    while (current && out.length < 30) {
      out.unshift({ id: current.id, name: current.name });
      const parentId = current.parentId;
      current = parentId ? portfolios.find((item) => item.id === parentId) : undefined;
    }
    return out;
  }, [portfolio, portfolios]);
  const children = useMemo(
    () =>
      portfolios
        .filter((item) => item.parentId === portfolioId)
        .sort((a, b) => a.name.localeCompare(b.name, intl(), { sensitivity: "base" })),
    [portfolios, portfolioId],
  );
  const items = useMemo(
    () =>
      documents
        .filter((document) => document.portfolioId === portfolioId)
        .sort((a, b) => a.title.localeCompare(b.title, intl(), { sensitivity: "base" })),
    [documents, portfolioId],
  );
  const countIn = (id: string) =>
    documents.filter((document) => document.portfolioId === id).length + portfolios.filter((item) => item.parentId === id).length;

  if (!portfolio) return null;

  return (
    <div
      data-home
      data-ui="portfolio-board"
      className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8"
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        openMenu(event, { kind: "portfolio", id: portfolioId });
      }}
    >
      <div className="w-full">
        <nav aria-label={t("Ruta")} className="flex flex-wrap items-center gap-1 text-xs text-faint">
          <button type="button" onClick={onHome} className="hover:text-fg">
            {t("Carpeta Personal")}
          </button>
          {trail.slice(0, -1).map((step) => (
            <span key={step.id} className="flex items-center gap-1">
              <ChevronRight className="size-3" />
              <button type="button" onClick={() => onOpenPortfolio(step.id)} className="hover:text-fg">
                {step.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <h1 className="min-w-0 font-serif text-4xl font-semibold tracking-tight break-words">{portfolio.name}</h1>
          <span className="ml-auto flex flex-wrap gap-2">
            <SpaceButton portfolioId={portfolioId} />
            <GitButton portfolioId={portfolioId} />
            <ZipButton portfolioId={portfolioId} />
            <NewTableButton portfolioId={portfolioId} onOpenNote={onOpenNote} />
            <NewDrawingButton portfolioId={portfolioId} onOpenNote={onOpenNote} />
            {onCreate ? (
              <button
                type="button"
                onClick={onCreate}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
              >
                <Plus className="size-4" />
                {t("Nueva nota")}
              </button>
            ) : null}
          </span>
        </div>
        <PortfolioAbout portfolio={portfolio} onOpenNote={onOpenNote} />
        {children.length === 0 && items.length === 0 ? (
          <p className="mt-8 text-sm text-faint">{t("Este portafolio está vacío.")}</p>
        ) : null}
        {children.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Portafolios")}</h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {children.map((child) => (
                <li key={child.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onOpenPortfolio(child.id)}
                    onContextMenu={(event) => openMenu(event, { kind: "portfolio", id: child.id })}
                    className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
                  >
                    <Folder className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate text-sm">{child.name}</span>
                    <span className="shrink-0 text-xs text-faint">{countIn(child.id)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {items.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Notas y archivos")}</h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {items.map((document) => {
                const Icon = document.kind === "file" ? (isTableName(document.file?.name ?? "") ? Sheet : File) : FileText;
                return (
                  <li key={document.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setActive(document.id)}
                      onContextMenu={(event) => openMenu(event, { kind: "document", id: document.id })}
                      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
                    >
                      <Icon className="size-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
                      <span className="shrink-0 text-xs text-faint">{formatWhen(document.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
      {menu}
    </div>
  );
}

/** «Nueva tabla» (datos con columnas y filas) en la carpeta que se está viendo. */
function NewTableButton({ portfolioId, onOpenNote }: { portfolioId: string | null; onOpenNote: (id: string) => void }) {
  const can = usePermissions();
  if (!can(PERMISSION.filesUpload)) return null;
  return (
    <button
      type="button"
      onClick={() => void createTable(portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""))}
      className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm text-fg hover:bg-elevated"
    >
      <Sheet className="size-4" />
      {t("Nueva tabla")}
    </button>
  );
}

/** «Nuevo dibujo» (Excalidraw) en la carpeta que se está viendo. */
function NewDrawingButton({ portfolioId, onOpenNote }: { portfolioId: string | null; onOpenNote: (id: string) => void }) {
  const can = usePermissions();
  if (!can(PERMISSION.filesUpload)) return null;
  return (
    <button
      type="button"
      onClick={() => void createDrawing(portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""))}
      className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm text-fg hover:bg-elevated"
    >
      <PenTool className="size-4" />
      {t("Nuevo dibujo")}
    </button>
  );
}

/** Vínculos del portafolio (a notas, archivos, portafolios o lo compartido conmigo). */
function PortfolioAbout({ portfolio, onOpenNote }: { portfolio: Portfolio; onOpenNote: (id: string) => void }) {
  const can = usePermissions();
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const trees = useSharedTrees((state) => state.trees);
  const setDialog = useVault((state) => state.setDialog);
  const removeLink = useVault((state) => state.removeManualLink);
  const canLink = can(PERMISSION.linksManage);
  const links = (portfolio.links ?? []).map((link) => ({ link, target: resolveLink(link, documents, portfolios, trees) }));

  return (
    <div data-ui="portfolio-about" className="mt-4 space-y-3">
      {links.length > 0 || canLink ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {links.map(({ link, target }) =>
            target ? (
              <span key={linkKey(link)} className="inline-flex h-8 max-w-full items-center gap-1 rounded-full border border-line pr-1 pl-2.5 text-xs">
                <button
                  type="button"
                  onClick={() => (target.open ? target.open() : onOpenNote(target.id))}
                  className="min-w-0 truncate text-fg hover:text-accent"
                >
                  <span className="text-accent">{link.kind === "llama" ? t("Invoca") : t("Referencia")}</span> · {target.title}
                </button>
                {canLink ? (
                  <button
                    type="button"
                    aria-label={t("Quitar vínculo")}
                    title={t("Quitar vínculo")}
                    onClick={() => removeLink(portfolio.id, link)}
                    className="grid size-6 shrink-0 place-items-center rounded-full text-faint hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </span>
            ) : null,
          )}
          {canLink ? (
            <button
              type="button"
              onClick={() => setDialog({ type: "link", sourceId: portfolio.id })}
              className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs text-accent hover:bg-elevated"
            >
              <Link2 className="size-3.5" />
              {t("Vincular")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SpaceButton({ portfolioId }: { portfolioId: string }) {
  const setDialog = useVault((state) => state.setDialog);
  return (
    <button
      type="button"
      data-ui="space-button"
      onClick={() => setDialog({ type: "space", portfolioId })}
      aria-label={t("Espacio y permisos")}
      title={t("Espacio y permisos")}
      className="inline-flex size-10 items-center justify-center rounded-md border border-line text-fg hover:bg-elevated"
    >
      <HardDrive className="size-4" />
    </button>
  );
}

function GitButton({ portfolioId }: { portfolioId: string }) {
  const can = usePermissions();
  const gitOn = usePluginEnabled("git");
  const setDialog = useVault((state) => state.setDialog);
  if (!gitOn || !can(PERMISSION.gitSync)) return null;
  return (
    <button
      type="button"
      data-ui="git-button"
      onClick={() => setDialog({ type: "git", portfolioId })}
      aria-label={t("Sincronizar con Git")}
      title={t("Sincronizar con Git")}
      className="inline-flex size-10 items-center justify-center rounded-md border border-line text-fg hover:bg-elevated"
    >
      <GitBranch className="size-4" />
    </button>
  );
}

/** El portafolio entero, con sus subportafolios, como .zip. */
function ZipButton({ portfolioId }: { portfolioId: string }) {
  const can = usePermissions();
  if (!can(PERMISSION.notesExport) && !can(PERMISSION.filesDownload)) return null;
  return (
    <button
      type="button"
      onClick={() => void downloadPortfolio(portfolioId)}
      aria-label={t("Descargar (.zip)")}
      title={t("Descargar (.zip)")}
      className="inline-flex size-10 items-center justify-center rounded-md border border-line text-fg hover:bg-elevated"
    >
      <Download className="size-4" />
    </button>
  );
}

function formatWhen(ms: number): string {
  if (!ms) return "";
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short" }).format(new Date(ms));
}
