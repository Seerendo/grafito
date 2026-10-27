import { Command } from "cmdk";
import { FilePlus, Link2, Network, RotateCcw, Search } from "lucide-react";
import type { ReactNode } from "react";
import { extractTags } from "@/domain/vault/links";
import { useVault } from "@/app/vault/store";
import { usePermissions } from "@/app/permissions";
import { PERMISSION } from "@/domain/permissions";
import { t } from "@/app/i18n";

export function CommandPalette({
  onOpenNote,
  onInspect,
  holdGraph,
}: {
  onOpenNote: (id: string) => void;
  onInspect: (id: string) => void;
  holdGraph: boolean;
}) {
  const open = useVault((state) => state.palette);
  const setPalette = useVault((state) => state.setPalette);
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const setActive = useVault((state) => state.setActive);
  const createDocument = useVault((state) => state.createDocument);
  const toggleGraph = useVault((state) => state.toggleGraph);
  const setMode = useVault((state) => state.setMode);
  const mode = useVault((state) => state.mode);
  const setDialog = useVault((state) => state.setDialog);
  const can = usePermissions();
  const setTag = useVault((state) => state.setTag);
  const selectedPortfolioId = useVault((state) => state.selectedPortfolioId);
  const activeId = useVault((state) => state.activeId);

  if (!open) return null;

  const tags = new Map<string, string>();
  for (const document of documents) {
    if (document.kind !== "markdown") continue;
    for (const tag of extractTags(document.content)) tags.set(tag.toLowerCase(), tag);
  }

  const close = () => setPalette(false);
  const go = (id: string) => {
    if (holdGraph) onInspect(id);
    else {
      setActive(id);
      onOpenNote(id);
    }
    close();
  };
  const portfolioName = (id: string | null) => portfolios.find((item) => item.id === id)?.name ?? t("Carpeta Personal");

  return (
    <div
      data-ui="overlay"
      className="fixed inset-0 z-40 flex items-start justify-center bg-inset/80 px-4 pt-24"
      onMouseDown={close}
    >
      <Command
        label={t("Paleta de comandos")}
        vimBindings={false}
        onMouseDown={(event) => event.stopPropagation()}
        data-ui="dialog"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-faint" />
          <Command.Input
            autoFocus
            placeholder={t("Buscar documentos o comandos")}
            className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-sm text-muted">{t("Sin resultados")}</Command.Empty>
          <Command.Group heading={t("Acciones")}>
            {can(PERMISSION.notesCreate) ? (
            <Command.Item
              value="crear nota nueva"
              onSelect={() => {
                const id = createDocument(selectedPortfolioId);
                onOpenNote(id);
                close();
              }}
            >
              <Row icon={<FilePlus className="size-4" />} label={t("Nueva nota")} hint="Ctrl N" />
            </Command.Item>
            ) : null}
            {can(PERMISSION.linksManage) ? (
            <Command.Item
              value="vincular documento a mano"
              onSelect={() => {
                if (!activeId) return;
                setDialog({ type: "link", sourceId: activeId });
                close();
              }}
            >
              <Row icon={<Link2 className="size-4" />} label={t("Vincular")} />
            </Command.Item>
            ) : null}
            {can(PERMISSION.graphView) ? (
            <Command.Item value="abrir grafo" onSelect={() => { toggleGraph(); close(); }}>
              <Row icon={<Network className="size-4" />} label={t("Mostrar u ocultar grafo")} hint="Ctrl G" />
            </Command.Item>
            ) : null}
            {can(PERMISSION.notesEdit) ? (
            <Command.Item
              value="cambiar modo lectura edicion"
              onSelect={() => {
                setMode(mode === "read" ? "edit" : mode === "edit" ? "split" : "read");
                close();
              }}
            >
              <Row icon={<Search className="size-4" />} label={t("Cambiar modo de la nota")} hint="Ctrl E" />
            </Command.Item>
            ) : null}
            {can(PERMISSION.notesCreate) && can(PERMISSION.notesDelete) ? (
              <Command.Item value="restaurar ejemplo" onSelect={() => setDialog({ type: "reset" })}>
                <Row icon={<RotateCcw className="size-4" />} label={t("Restaurar notas de ejemplo")} />
              </Command.Item>
            ) : null}
          </Command.Group>
          <Command.Group heading={t("Documentos")}>
            {documents.map((document) => (
              <Command.Item
                key={document.id}
                value={`${document.title} ${portfolioName(document.portfolioId)} ${document.kind}`}
                keywords={[portfolioName(document.portfolioId), document.kind]}
                onSelect={() => go(document.id)}
              >
                <Row
                  icon={<span className="size-4" />}
                  label={document.title}
                  hint={document.kind === "file" ? "archivo" : portfolioName(document.portfolioId)}
                />
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading={t("Etiquetas")}>
            {[...tags.values()].map((tag) => (
              <Command.Item key={tag} value={`etiqueta ${tag}`} onSelect={() => setTag(tag)}>
                <Row icon={<span className="text-xs text-accent">#</span>} label={tag} />
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Row({ icon, label, hint }: { icon: ReactNode; label: string; hint?: string }) {
  return (
    <span className="flex h-11 items-center gap-2 px-2 text-sm">
      <span className="text-muted">{icon}</span>
      <span className="truncate">{label}</span>
      {hint ? <span className="ml-auto shrink-0 text-xs text-faint">{t(hint)}</span> : null}
    </span>
  );
}
