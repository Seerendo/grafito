import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { SizeField } from "@/components/ui/SizeField";
import { formatBytes } from "@/domain/space";
import { createOrgWorkspace, setWorkspaceAdmin, setWorkspaceSpace, workspaceOverview } from "@/server/workspace.functions";
import { t } from "@/app/i18n";

type Overview = Extract<Awaited<ReturnType<typeof workspaceOverview>>, { ok: true }>;

/**
 * Administración → Usuarios y permisos → Espacios de trabajo: el de cada
 * organización, con su espacio (lo de las suborganizaciones sale de él) y sus
 * administradores. Ver `server/workspace.ts`.
 */
export function WorkspaceBoard() {
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const result = await workspaceOverview().catch(() => null);
    if (result?.ok) setData(result);
    else setFailed(true);
  };

  useEffect(() => {
    void load();
  }, []);

  if (failed) return <p className="text-sm text-danger">{t("No se pudieron leer los espacios de trabajo.")}</p>;
  if (!data) return <p className="text-sm text-faint">{t("Cargando…")}</p>;
  if (data.items.length === 0) return <p className="text-sm text-muted">{t("Todavía no hay organizaciones.")}</p>;

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError("");
    const result = await action().catch(() => ({ ok: false, error: "No se pudo guardar." }));
    if (!result.ok) {
      setError(result.error ?? "No se pudo guardar.");
      return result.error ?? "No se pudo guardar.";
    }
    await load();
    return null;
  };

  return (
    <div data-ui="workspace-board" className="space-y-3">
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[46rem] table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-64" />
            <col className="w-36" />
            <col className="w-56" />
          </colgroup>
          <thead className="bg-inset text-left text-xs text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">{t("Organización")}</th>
              <th className="px-3 py-2 font-medium">{t("Administradores")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("Usado")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("Espacio")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const depth = item.path.length - 1;
              const name = item.path[item.path.length - 1] ?? "";
              const ws = item.workspace;
              return (
                <tr key={item.orgId} className="border-t border-line align-middle">
                  <td className="min-w-0 px-3 py-2">
                    <span className="block truncate text-fg" style={{ paddingLeft: `${depth * 1.25}rem` }} title={item.path.join(" / ")}>
                      {name}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {ws ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {ws.admins.map((admin) => (
                          <span key={admin.id} className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-elevated pr-1 pl-2.5 text-xs text-fg">
                            <span className="truncate">{admin.name}</span>
                            <button
                              type="button"
                              aria-label={t("Quitar a {0}", { 0: admin.name })}
                              title={t("Quitar a {0}", { 0: admin.name })}
                              onClick={() => void run(() => setWorkspaceAdmin({ data: { orgId: item.orgId, userId: admin.id, admin: false } }))}
                              className="grid size-5 place-items-center rounded-full text-faint hover:text-fg"
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                        <select
                          value=""
                          aria-label={t("Añadir administrador")}
                          onChange={(event) => {
                            const userId = event.target.value;
                            if (userId) void run(() => setWorkspaceAdmin({ data: { orgId: item.orgId, userId, admin: true } }));
                          }}
                          className="h-7 max-w-[9rem] rounded-full border border-line bg-inset px-2 text-xs text-muted"
                        >
                          <option value="">{t("+ Administrador")}</option>
                          {data.users
                            .filter((user) => ws.candidates.includes(user.id))
                            .filter((user) => !ws.admins.some((admin) => admin.id === user.id))
                            .map((user) => (
                              <option key={user.id} value={user.id}>
                                {user.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right text-muted tabular-nums">
                    {ws ? (
                      <>
                        <span className="block">{formatBytes(ws.used)}</span>
                        {ws.given ? (
                          <span className="block text-xs text-faint">{t("{0} a sus organizaciones", { 0: formatBytes(ws.given) })}</span>
                        ) : null}
                      </>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {ws ? (
                      <SizeField
                        value={ws.bytes}
                        label={t("Espacio de {0}", { 0: name })}
                        onSave={(bytes) => run(() => setWorkspaceSpace({ data: { orgId: item.orgId, bytes } }))}
                      />
                    ) : (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => void run(() => createOrgWorkspace({ data: { orgId: item.orgId } }))}
                          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-fg hover:bg-elevated"
                        >
                          <Plus className="size-3.5" />
                          {t("Crear espacio de trabajo")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
