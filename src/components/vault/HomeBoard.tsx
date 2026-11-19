import {
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  GitBranch,
  HardDrive,
  Link2,
  PenTool,
  Plus,
  Sheet,
  X,
} from "lucide-react";
import { isTableName } from "@/domain/vault/table";
import { tallyFolder } from "@/domain/vault/tally";
import { resolveLink, useSharedTrees } from "@/app/shared-links";
import { linkKey } from "@/domain/vault/anchor";
import type { Portfolio } from "@/domain/vault/types";
import { usePluginEnabled } from "@/app/plugins";
import { downloadPortfolio } from "@/app/export";
import { usePermissions } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import { createDrawing, createTable } from "./ingest-files";
import { useMemo } from "react";
import { create } from "zustand";
import { useVault } from "@/app/vault/store";
import { intl, t } from "@/app/i18n";
import { useDirectoryPick } from "@/app/directory-pick";
import { PendingSignatures } from "./SignatureDialog";
import { useRowMenu } from "./RowMenu";

const RECENT = 12;

/** Add the row to directory selection without opening it. */
function selectInDirectory(target: { kind: "document" | "portfolio"; id: string }) {
  useDirectoryPick
    .getState()
    .add(target.kind === "document" ? `doc:${target.id}` : `port:${target.id}`);
}

/** Vault root with portfolios, recent changes and directory-equivalent context menus. */
export function HomeBoard({
  onCreate,
  onOpenNote,
}: {
  onCreate?: () => void;
  onOpenNote: (id: string) => void;
}) {
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
  const { openMenu, element: menu } = useRowMenu(onOpenNote, selectInDirectory);
  const recent = useMemo(
    () => [...documents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT),
    [documents],
  );
  const place = (id: string | null) =>
    portfolios.find((portfolio) => portfolio.id === id)?.name ?? t("Carpeta Personal");

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
          <h1 className="font-serif text-4xl font-semibold tracking-tight">
            {t("Carpeta Personal")}
          </h1>
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
        <FolderCount rootId={null} />
        <div className="mt-8">
          <PendingSignatures onOpenNote={onOpenNote} />
        </div>
        {roots.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">
              {t("Portafolios")}
            </h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              <FolderRows
                items={roots}
                depth={0}
                onOpenPortfolio={openPortfolio}
                onOpenDocument={setActive}
                openMenu={openMenu}
              />
            </ul>
          </section>
        ) : null}
        {recent.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">
              {t("Recientes")}
            </h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {recent.map((document) => {
                const Icon =
                  document.kind === "file"
                    ? isTableName(document.file?.name ?? "")
                      ? Sheet
                      : File
                    : FileText;
                return (
                  <li key={document.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setActive(document.id)}
                      onContextMenu={(event) =>
                        openMenu(event, { kind: "document", id: document.id })
                      }
                      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
                    >
                      <Icon className="size-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
                      <span className="hidden shrink-0 text-xs text-faint sm:inline">
                        {place(document.portfolioId)}
                      </span>
                      <span className="shrink-0 text-xs text-faint">
                        {formatWhen(document.updatedAt)}
                      </span>
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
 * Portfolio page with breadcrumbs, child portfolios, notes, files and directory-equivalent
 * context menus.
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
        <nav
          aria-label={t("Ruta")}
          className="flex flex-wrap items-center gap-1 text-xs text-faint"
        >
          <button type="button" onClick={onHome} className="hover:text-fg">
            {t("Carpeta Personal")}
          </button>
          {trail.slice(0, -1).map((step) => (
            <span key={step.id} className="flex items-center gap-1">
              <ChevronRight className="size-3" />
              <button
                type="button"
                onClick={() => onOpenPortfolio(step.id)}
                className="hover:text-fg"
              >
                {step.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <h1 className="min-w-0 font-serif text-4xl font-semibold tracking-tight break-words">
            {portfolio.name}
          </h1>
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
        <FolderCount rootId={portfolioId} />
        <PortfolioAbout portfolio={portfolio} onOpenNote={onOpenNote} />
        {children.length === 0 && items.length === 0 ? (
          <p className="mt-8 text-sm text-faint">{t("Este portafolio está vacío.")}</p>
        ) : null}
        {children.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">
              {t("Portafolios")}
            </h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              <FolderRows
                items={children}
                depth={0}
                onOpenPortfolio={onOpenPortfolio}
                onOpenDocument={setActive}
                openMenu={openMenu}
              />
            </ul>
          </section>
        ) : null}
        {items.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">
              {t("Notas y archivos")}
            </h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {items.map((document) => {
                const Icon =
                  document.kind === "file"
                    ? isTableName(document.file?.name ?? "")
                      ? Sheet
                      : File
                    : FileText;
                return (
                  <li key={document.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setActive(document.id)}
                      onContextMenu={(event) =>
                        openMenu(event, { kind: "document", id: document.id })
                      }
                      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-elevated"
                    >
                      <Icon className="size-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
                      <span className="shrink-0 text-xs text-faint">
                        {formatWhen(document.updatedAt)}
                      </span>
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

/** Portfolios unfolded on the central pages, kept while the app is open. */
const useBoardOpen = create<{ open: Record<string, boolean> }>(() => ({ open: {} }));

function toggleBoardOpen(id: string) {
  useBoardOpen.setState((state) => ({ open: { ...state.open, [id]: !state.open[id] } }));
}

const INDENT = ["pl-4", "pl-9", "pl-14", "pl-19", "pl-24", "pl-29"];

function indentOf(depth: number): string {
  return INDENT[Math.min(depth, INDENT.length - 1)] ?? "pl-4";
}

function documentIcon(document: { kind: string; file?: { name: string } | null }) {
  return document.kind === "file"
    ? isTableName(document.file?.name ?? "")
      ? Sheet
      : File
    : FileText;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, intl(), { sensitivity: "base" });

/**
 * Portfolio rows on a central page. The arrow folds or unfolds the portfolio in place, showing
 * its portfolios and documents below it; the name opens the portfolio's page.
 */
function FolderRows({
  items,
  depth,
  onOpenPortfolio,
  onOpenDocument,
  openMenu,
}: {
  items: Portfolio[];
  depth: number;
  onOpenPortfolio: (id: string) => void;
  onOpenDocument: (id: string) => void;
  openMenu: ReturnType<typeof useRowMenu>["openMenu"];
}) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const open = useBoardOpen((state) => state.open);
  return (
    <>
      {items.map((portfolio) => {
        const unfolded = Boolean(open[portfolio.id]);
        const subfolders = portfolios.filter((item) => item.parentId === portfolio.id);
        const inside = documents.filter((document) => document.portfolioId === portfolio.id);
        return (
          <li key={portfolio.id} className="border-b border-line last:border-b-0">
            <div className={`flex min-h-12 items-center ${indentOf(depth)} pr-4 hover:bg-elevated`}>
              <button
                type="button"
                aria-expanded={unfolded}
                aria-label={
                  unfolded
                    ? t("Plegar {0}", { 0: portfolio.name })
                    : t("Desplegar {0}", { 0: portfolio.name })
                }
                onClick={() => toggleBoardOpen(portfolio.id)}
                className="-ml-2 grid size-9 shrink-0 place-items-center rounded-md text-faint hover:text-fg"
              >
                <ChevronRight
                  className={`size-4 transition-transform ${unfolded ? "rotate-90" : ""}`}
                />
              </button>
              <button
                type="button"
                onClick={() => onOpenPortfolio(portfolio.id)}
                onContextMenu={(event) => openMenu(event, { kind: "portfolio", id: portfolio.id })}
                className="flex min-h-12 min-w-0 flex-1 items-center gap-3 py-2 text-left"
              >
                <Folder className="size-4 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate text-sm">{portfolio.name}</span>
                <span className="shrink-0 text-xs text-faint">
                  {subfolders.length + inside.length}
                </span>
              </button>
            </div>
            {unfolded && subfolders.length + inside.length > 0 ? (
              <ul className="border-t border-line">
                <FolderRows
                  items={[...subfolders].sort(byName)}
                  depth={depth + 1}
                  onOpenPortfolio={onOpenPortfolio}
                  onOpenDocument={onOpenDocument}
                  openMenu={openMenu}
                />
                {[...inside]
                  .sort((a, b) => a.title.localeCompare(b.title, intl(), { sensitivity: "base" }))
                  .map((document) => {
                    const Icon = documentIcon(document);
                    return (
                      <li key={document.id} className="border-b border-line last:border-b-0">
                        <button
                          type="button"
                          onClick={() => onOpenDocument(document.id)}
                          onContextMenu={(event) =>
                            openMenu(event, { kind: "document", id: document.id })
                          }
                          className={`flex min-h-11 w-full items-center gap-3 ${indentOf(depth + 1)} py-2 pr-4 text-left hover:bg-elevated`}
                        >
                          <span className="w-5 shrink-0" />
                          <Icon className="size-4 shrink-0 text-faint" />
                          <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

/**
 * Folders and files directly inside and everything below, as a file manager shows them, to
 * check that an upload arrived complete.
 */
function FolderCount({ rootId }: { rootId: string | null }) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const tally = useMemo(
    () => tallyFolder(portfolios, documents, rootId),
    [portfolios, documents, rootId],
  );
  const part = (count: { folders: number; files: number }) =>
    `${t(count.folders === 1 ? "{0} carpeta" : "{0} carpetas", { 0: count.folders })} · ${t(
      count.files === 1 ? "{0} archivo" : "{0} archivos",
      { 0: count.files },
    )}`;
  const nested = tally.total.folders !== tally.direct.folders;
  return (
    <p data-ui="folder-count" className="mt-1 text-xs text-faint tabular-nums">
      {part(tally.direct)}
      {nested ? ` · ${t("en total: {0}", { 0: part(tally.total) })}` : ""}
    </p>
  );
}

/** Create a data table in the current folder. */
function NewTableButton({
  portfolioId,
  onOpenNote,
}: {
  portfolioId: string | null;
  onOpenNote: (id: string) => void;
}) {
  const can = usePermissions();
  if (!can(PERMISSION.filesUpload)) return null;
  return (
    <button
      type="button"
      onClick={() =>
        void createTable(portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""))
      }
      className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm text-fg hover:bg-elevated"
    >
      <Sheet className="size-4" />
      {t("Nueva tabla")}
    </button>
  );
}

/** Create an Excalidraw drawing in the current folder. */
function NewDrawingButton({
  portfolioId,
  onOpenNote,
}: {
  portfolioId: string | null;
  onOpenNote: (id: string) => void;
}) {
  const can = usePermissions();
  if (!can(PERMISSION.filesUpload)) return null;
  return (
    <button
      type="button"
      onClick={() =>
        void createDrawing(portfolioId).then(() => onOpenNote(useVault.getState().activeId ?? ""))
      }
      className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm text-fg hover:bg-elevated"
    >
      <PenTool className="size-4" />
      {t("Nuevo dibujo")}
    </button>
  );
}

/** Portfolio links to notes, files, portfolios or shared targets. */
function PortfolioAbout({
  portfolio,
  onOpenNote,
}: {
  portfolio: Portfolio;
  onOpenNote: (id: string) => void;
}) {
  const can = usePermissions();
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const trees = useSharedTrees((state) => state.trees);
  const setDialog = useVault((state) => state.setDialog);
  const removeLink = useVault((state) => state.removeManualLink);
  const canLink = can(PERMISSION.linksManage);
  const links = (portfolio.links ?? []).map((link) => ({
    link,
    target: resolveLink(link, documents, portfolios, trees),
  }));

  return (
    <div data-ui="portfolio-about" className="mt-4 space-y-3">
      {links.length > 0 || canLink ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {links.map(({ link, target }) =>
            target ? (
              <span
                key={linkKey(link)}
                className="inline-flex h-8 max-w-full items-center gap-1 rounded-full border border-line pr-1 pl-2.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => (target.open ? target.open() : onOpenNote(target.id))}
                  className="min-w-0 truncate text-fg hover:text-accent"
                >
                  <span className="text-accent">
                    {link.kind === "llama" ? t("Invoca") : t("Referencia")}
                  </span>{" "}
                  · {target.title}
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

/** Download the portfolio subtree as ZIP. */
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
