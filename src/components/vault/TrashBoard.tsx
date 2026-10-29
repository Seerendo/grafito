import { Building2, File, FileText, Folder, House } from "lucide-react";
import { useEffect, useState } from "react";
import { usePermissions } from "@/app/permissions";
import { useTrashView } from "@/app/trash-view";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { TextAction } from "@/components/ui/TextAction";
import { useContextMenu } from "@/components/ui/use-context-menu";
import { useAutoContextMenu } from "@/components/ui/use-auto-context-menu";
import { PERMISSION } from "@/domain/permissions";
import { trashList, trashPurge, trashRestore } from "@/server/history.functions";
import {
  myWorkspaceTrashes,
  workspaceTrashList,
  workspaceTrashPurge,
  workspaceTrashRestore,
} from "@/server/workspace-trash.functions";
import { intl, t } from "@/app/i18n";

type Item = Awaited<ReturnType<typeof trashList>>[number];

/** Días que se guarda un documento en la papelera (`TRASH_DAYS` en el servidor). */
const TRASH_DAYS = 30;

/**
 * Papelera: recuperar o borrar para siempre lo eliminado (un portafolio, con
 * lo que contiene dentro). Una pestaña para la
 * Carpeta Personal y otra por cada espacio de trabajo que administro (solo sus
 * administradores ven y recuperan lo que se borró allí).
 */
export function TrashBoard() {
  const can = usePermissions();
  const canRestore = can(PERMISSION.notesCreate) || can(PERMISSION.filesUpload);
  const canPurge = can(PERMISSION.notesDelete) || can(PERMISSION.filesDelete);
  const [spaces, setSpaces] = useState<{ shareId: string; name: string }[]>([]);
  const [tab, setTab] = useState<string | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const menu = useContextMenu();
  // Fuera de un elemento: vaciar, cambiar de pestaña… (lo mismo que los botones).
  const autoMenu = useAutoContextMenu();
  // En un espacio de trabajo, quien lo administra puede recuperar y vaciar.
  const mayRestore = tab ? true : canRestore;
  const mayPurge = tab ? true : canPurge;

  useEffect(() => {
    void myWorkspaceTrashes()
      .then(setSpaces)
      .catch(() => setSpaces([]));
  }, []);

  const load = async (which = tab) => {
    setItems(null);
    try {
      if (which) {
        const result = await workspaceTrashList({ data: { shareId: which } });
        setItems(result.items);
      } else {
        // Antes se sube lo pendiente, para que lo recién borrado ya esté aquí.
        const owner = useVault.getState().owner;
        if (owner) await syncVault(owner);
        setItems(await trashList());
      }
      setError("");
    } catch {
      setError(t("No se pudo leer la papelera."));
    }
  };

  useEffect(() => {
    setConfirming(null);
    setNotice("");
    void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const restore = async (id: string) => {
    setBusy(id);
    setNotice("");
    try {
      const result = tab ? await workspaceTrashRestore({ data: { shareId: tab, id } }) : await trashRestore({ data: { id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (tab) {
        setNotice(t("Recuperado en el espacio de trabajo."));
        await load();
        return;
      }
      const owner = useVault.getState().owner;
      if (owner) await syncVault(owner);
      useTrashView.getState().setOpen(false);
      if (result.kind === "portfolio") useVault.getState().openPortfolio(result.id);
      else useVault.getState().setActive(result.id);
    } catch {
      setError(t("No se pudo recuperar."));
    } finally {
      setBusy(null);
    }
  };

  const purge = async (ids?: string[]) => {
    setConfirming(null);
    setBusy(ids?.[0] ?? "all");
    try {
      const result = tab ? await workspaceTrashPurge({ data: { shareId: tab, ids } }) : await trashPurge({ data: { ids } });
      if (!result.ok) setError(result.error);
      await load();
    } catch {
      setError(t("No se pudo borrar."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-ui="trash" className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8" onContextMenu={autoMenu.onContextMenu}>
      <div className="w-full">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="font-serif text-4xl font-semibold tracking-tight">{t("Papelera")}</h1>
          {mayPurge && items && items.length > 0 ? (
            <span className="ml-auto flex items-center gap-3 text-sm">
              {confirming === "all" ? (
                <>
                  <span className="text-muted">{t("¿Vaciar la papelera?")}</span>
                  <TextAction tone="danger" onClick={() => void purge()}>
                    {t("Sí")}
                  </TextAction>
                  <TextAction onClick={() => setConfirming(null)}>{t("No")}</TextAction>
                </>
              ) : (
                <TextAction tone="danger" menuLabel={t("Vaciar papelera")} onClick={() => setConfirming("all")}>
                  {t("Vaciar")}
                </TextAction>
              )}
            </span>
          ) : null}
        </div>
        {spaces.length > 0 ? (
          <div role="tablist" data-ui="trash-tabs" className="mt-5 flex flex-wrap gap-1.5">
            {[{ shareId: null as string | null, name: t("Carpeta Personal") }, ...spaces].map((space) => {
              const Icon = space.shareId ? Building2 : House;
              const on = tab === space.shareId;
              return (
                <button
                  key={space.shareId ?? "personal"}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTab(space.shareId)}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm ${
                    on ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-elevated hover:text-fg"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {space.name}
                </button>
              );
            })}
          </div>
        ) : null}
        {error ? <p className="mt-4 text-sm text-danger">{t(error)}</p> : null}
        {notice ? <p className="mt-4 text-sm text-muted">{notice}</p> : null}
        {!items && !error ? <p className="mt-6 text-sm text-muted">{t("Cargando…")}</p> : null}
        {items && items.length === 0 ? <p className="mt-6 text-sm text-muted">{t("La papelera está vacía.")}</p> : null}
        {items && items.length > 0 ? (
          <ul data-ui="trash-list" className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
            {items.map((item) => {
              const Icon = item.kind === "portfolio" ? Folder : item.kind === "file" ? File : FileText;
              const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - item.deletedAt) / 86_400_000));
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0"
                  onContextMenu={(event) =>
                    menu.open(event, [
                      ...(mayRestore ? [{ label: t("Recuperar"), onClick: () => void restore(item.id) }] : []),
                      ...(mayPurge ? [{ label: t("Eliminar para siempre"), danger: true, onClick: () => setConfirming(item.id) }] : []),
                    ])
                  }
                >
                  <Icon className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.title}</span>
                    <span className="block text-xs text-faint">
                      {item.kind === "portfolio"
                        ? `${t("Portafolio")} · ${item.count ?? 0} ${item.count === 1 ? t("documento") : t("documentos")} · `
                        : ""}
                      {item.portfolioName ?? t("Carpeta Personal")} · {formatWhen(item.deletedAt)} · {left} {left === 1 ? t("día") : t("días")}
                    </span>
                  </span>
                  {confirming === item.id ? (
                    <span className="flex items-center gap-3">
                      <span className="text-muted">{t("¿Borrar para siempre?")}</span>
                      <TextAction tone="danger" onClick={() => void purge([item.id])}>
                        {t("Sí")}
                      </TextAction>
                      <TextAction onClick={() => setConfirming(null)}>{t("No")}</TextAction>
                    </span>
                  ) : (
                    <span className="flex items-center gap-4">
                      {mayRestore ? (
                        <TextAction onClick={() => void restore(item.id)}>{busy === item.id ? t("…") : t("Recuperar")}</TextAction>
                      ) : null}
                      {mayPurge ? (
                        <TextAction tone="danger" onClick={() => setConfirming(item.id)}>
                          {t("Eliminar")}
                        </TextAction>
                      ) : null}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {menu.element}
        {autoMenu.element}
      </div>
    </div>
  );
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
