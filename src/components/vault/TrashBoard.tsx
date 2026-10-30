import { Building2, File, FileText, Folder, House, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { usePermissions } from "@/app/permissions";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { TextAction } from "@/components/ui/TextAction";
import { Modal } from "@/components/ui/Modal";
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
  const [confirming, setConfirming] = useState<"all" | string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
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
    setPicked([]);
    setAnchor(null);
    void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /** Recupera uno o varios y se queda en la papelera. Se detiene en el primer fallo. */
  const restoreMany = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(ids[0] ?? "many");
    setNotice("");
    setError("");
    let failed = false;
    try {
      for (const id of ids) {
        const result = tab ? await workspaceTrashRestore({ data: { shareId: tab, id } }) : await trashRestore({ data: { id } });
        if (!result.ok) {
          setError(result.error);
          failed = true;
          break;
        }
      }
      if (!tab) {
        const owner = useVault.getState().owner;
        if (owner) await syncVault(owner);
      }
      setPicked([]);
      setAnchor(null);
      await load();
      if (!failed) {
        setNotice(
          ids.length > 1 ? t("Recuperados.") : tab ? t("Recuperado en el espacio de trabajo.") : t("Recuperado."),
        );
      }
    } catch {
      setError(t("No se pudo recuperar."));
    } finally {
      setBusy(null);
    }
  };

  const pickRow = (event: React.MouseEvent, id: string) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const ids = (items ?? []).map((item) => item.id);
    if (event.shiftKey && anchor && ids.includes(anchor)) {
      const from = ids.indexOf(anchor);
      const to = ids.indexOf(id);
      const [start, end] = from < to ? [from, to] : [to, from];
      const range = ids.slice(start, end + 1);
      setPicked(event.ctrlKey || event.metaKey ? [...new Set([...picked, ...range])] : range);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
      setAnchor(id);
      return;
    }
    // Un segundo clic en el único elegido lo suelta.
    if (picked.length === 1 && picked[0] === id) {
      setPicked([]);
      setAnchor(null);
      return;
    }
    setPicked([id]);
    setAnchor(id);
  };

  const purge = async (ids?: string[]) => {
    setConfirming(null);
    setBusy(ids?.[0] ?? "all");
    try {
      const result = tab ? await workspaceTrashPurge({ data: { shareId: tab, ids } }) : await trashPurge({ data: { ids } });
      if (!result.ok) setError(result.error);
      else {
        const gone = new Set(ids ?? []);
        setPicked((current) => (ids ? current.filter((item) => !gone.has(item)) : []));
        setAnchor(null);
      }
      await load();
    } catch {
      setError(t("No se pudo borrar."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-ui="trash"
      className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8"
      onContextMenu={autoMenu.onContextMenu}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-trash-row], button")) return;
        setPicked([]);
        setAnchor(null);
      }}
    >
      <div className="w-full">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="font-serif text-4xl font-semibold tracking-tight">{t("Papelera")}</h1>
          {items && items.length > 0 && (picked.length > 0 || mayPurge) ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {mayRestore && picked.length > 0 ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void restoreMany(picked)}
                  className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
                >
                  {t("Recuperar {n}", { n: picked.length })}
                </button>
              ) : null}
              {mayPurge ? (
                <button
                  type="button"
                  data-menu-label={t("Vaciar papelera")}
                  disabled={busy !== null}
                  onClick={() => setConfirming("all")}
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-danger/40 px-4 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  <Trash2 className="size-4" />
                  {t("Vaciar papelera")}
                </button>
              ) : null}
            </div>
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
              const on = picked.includes(item.id);
              const chosen = on && picked.length > 1 ? picked : [item.id];
              return (
                <li
                  key={item.id}
                  data-trash-row
                  aria-selected={on}
                  onClick={(event) => pickRow(event, item.id)}
                  className={`flex cursor-pointer flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0 ${on ? "bg-accent/15" : "hover:bg-elevated"}`}
                  onContextMenu={(event) =>
                    menu.open(event, [
                      ...(mayRestore
                        ? [
                            {
                              label: chosen.length > 1 ? t("Recuperar {n}", { n: chosen.length }) : t("Recuperar"),
                              onClick: () => void restoreMany(chosen),
                            },
                          ]
                        : []),
                      ...(mayPurge
                        ? [
                            {
                              label: chosen.length > 1 ? t("Eliminar {n}", { n: chosen.length }) : t("Eliminar para siempre"),
                              danger: true,
                              onClick: () => setConfirming(chosen),
                            },
                          ]
                        : []),
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
                  <span className="flex items-center gap-4">
                    {mayRestore ? (
                      <TextAction onClick={() => void restoreMany([item.id])}>{busy === item.id ? t("…") : t("Recuperar")}</TextAction>
                    ) : null}
                    {mayPurge ? (
                      <TextAction tone="danger" onClick={() => setConfirming(chosen)}>
                        {chosen.length > 1 ? t("Eliminar {n}", { n: chosen.length }) : t("Eliminar")}
                      </TextAction>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {menu.element}
        {autoMenu.element}
        {confirming ? (
          <Modal
            title={confirming === "all" ? t("Vaciar la papelera") : t("Eliminar para siempre")}
            onClose={() => setConfirming(null)}
          >
            <p className="text-sm text-muted">
              {confirming === "all"
                ? t("Se borrará para siempre todo lo que hay en esta papelera ({n}). No se puede deshacer.", { n: items?.length ?? 0 })
                : confirming.length > 1
                  ? t("Se borrarán para siempre {n} elementos. No se puede deshacer.", { n: confirming.length })
                  : t("«{0}» se borrará para siempre. No se puede deshacer.", {
                      0: items?.find((item) => item.id === confirming[0])?.title ?? "",
                    })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(null)} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated">
                {t("Cancelar")}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void purge(confirming === "all" ? undefined : confirming)}
                className="h-11 rounded-md bg-danger px-4 text-sm font-medium text-accent-fg"
              >
                {confirming === "all" ? t("Vaciar") : t("Eliminar para siempre")}
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    </div>
  );
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
