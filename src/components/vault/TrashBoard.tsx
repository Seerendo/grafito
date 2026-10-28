import { File, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { usePermissions } from "@/app/permissions";
import { useTrashView } from "@/app/trash-view";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { TextAction } from "@/components/ui/TextAction";
import { PERMISSION } from "@/domain/permissions";
import { trashList, trashPurge, trashRestore } from "@/server/history.functions";
import { intl, t } from "@/app/i18n";

type Item = Awaited<ReturnType<typeof trashList>>[number];

/** Días que se guarda un documento en la papelera (`TRASH_DAYS` en el servidor). */
const TRASH_DAYS = 30;

/** Papelera: recuperar o borrar para siempre lo eliminado. */
export function TrashBoard() {
  const can = usePermissions();
  const canRestore = can(PERMISSION.notesCreate) || can(PERMISSION.filesUpload);
  const canPurge = can(PERMISSION.notesDelete) || can(PERMISSION.filesDelete);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    // Antes se sube lo pendiente, para que lo recién borrado ya esté aquí.
    const owner = useVault.getState().owner;
    if (owner) await syncVault(owner);
    try {
      setItems(await trashList());
      setError("");
    } catch {
      setError(t("No se pudo leer la papelera."));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      const result = await trashRestore({ data: { id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const owner = useVault.getState().owner;
      if (owner) await syncVault(owner);
      useTrashView.getState().setOpen(false);
      useVault.getState().setActive(result.id);
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
      const result = await trashPurge({ data: { ids } });
      if (!result.ok) setError(result.error);
      await load();
    } catch {
      setError(t("No se pudo borrar."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8">
      <div className="w-full">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="font-serif text-4xl font-semibold tracking-tight">{t("Papelera")}</h1>
          {canPurge && items && items.length > 0 ? (
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
                <TextAction tone="danger" onClick={() => setConfirming("all")}>
                  {t("Vaciar")}
                </TextAction>
              )}
            </span>
          ) : null}
        </div>
        {error ? <p className="mt-4 text-sm text-danger">{t(error)}</p> : null}
        {!items && !error ? <p className="mt-6 text-sm text-muted">{t("Cargando…")}</p> : null}
        {items && items.length === 0 ? <p className="mt-6 text-sm text-muted">{t("La papelera está vacía.")}</p> : null}
        {items && items.length > 0 ? (
          <ul className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
            {items.map((item) => {
              const Icon = item.kind === "file" ? File : FileText;
              const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - item.deletedAt) / 86_400_000));
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0">
                  <Icon className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.title}</span>
                    <span className="block text-xs text-faint">
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
                      {canRestore ? (
                        <TextAction onClick={() => void restore(item.id)}>{busy === item.id ? t("…") : t("Recuperar")}</TextAction>
                      ) : null}
                      {canPurge ? (
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
      </div>
    </div>
  );
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
