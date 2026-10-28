import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { SizeField } from "@/components/ui/SizeField";
import { UsageMeter } from "@/components/ui/UsageMeter";
import { formatBytes } from "@/domain/space";
import { portfolioSpace, setMemberAccess, setMemberSpace, setPortfolioSpace, type SpaceMember } from "@/server/space.functions";
import { t } from "@/app/i18n";

type State = {
  name: string;
  used: number;
  limit: number | null;
  canManage: boolean;
  canSetLimit: boolean;
  members: SpaceMember[];
};

const ACCESS_LABEL: Record<SpaceMember["access"], string> = {
  owner: "Dueño",
  read: "Solo lectura",
  edit: "Puede editar",
  admin: "Administra",
};

/**
 * Espacio y permisos de un portafolio (propio, o compartido conmigo con
 * `shareId`). Quien lo administra reparte su espacio entre los usuarios y les
 * cambia el permiso; el tope del portafolio lo pone el administrador del
 * sistema. Ver `server/space.functions.ts`.
 */
export function SpaceDialog({ portfolioId, shareId, onClose }: { portfolioId: string; shareId?: string; onClose: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const scope = { portfolioId, ...(shareId ? { shareId } : {}) };

  const load = async () => {
    const result = await portfolioSpace({ data: scope }).catch(() => null);
    if (!result?.ok) setError("No tienes acceso a este portafolio.");
    else setState(result);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolioId, shareId]);

  const apply = (result: { ok: true } & State | { ok: false; error: string }): string | null => {
    if (!result.ok) return result.error;
    setState(result);
    return null;
  };

  return (
    <Modal title={t("Espacio y permisos")} onClose={onClose} wide>
      {error ? (
        <p className="text-sm text-danger">{t(error)}</p>
      ) : !state ? (
        <p className="text-sm text-faint">{t("Cargando…")}</p>
      ) : (
        <div data-ui="space-dialog" className="space-y-5">
          <section>
            <p className="truncate text-sm text-muted">{state.name}</p>
            <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-2">
              <p className="text-sm text-fg">
                {state.limit === null
                  ? t("{used} usados · sin tope", { used: formatBytes(state.used) })
                  : t("{used} de {limit}", { used: formatBytes(state.used), limit: formatBytes(state.limit) })}
              </p>
              {state.canSetLimit ? (
                <div className="ml-auto flex items-center gap-2 text-xs text-muted">
                  <span>{t("Espacio del portafolio")}</span>
                  <SizeField
                    value={state.limit}
                    label={t("Espacio del portafolio")}
                    onSave={async (bytes) => {
                      const result = await setPortfolioSpace({ data: { ...scope, bytes } });
                      if (!result.ok) return result.error;
                      await load();
                      return null;
                    }}
                  />
                </div>
              ) : null}
            </div>
            {state.limit ? <UsageMeter percent={(state.used / state.limit) * 100} label={t("Espacio usado")} /> : null}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
              {state.canManage ? t("Usuarios") : t("Tu espacio aquí")}
            </h3>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[44rem] table-fixed text-sm">
                <colgroup>
                  <col />
                  <col className="w-40" />
                  <col className="w-32" />
                  <col className="w-56" />
                </colgroup>
                <thead className="bg-inset text-left text-xs text-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t("Usuario")}</th>
                    <th className="px-3 py-2 font-medium">{t("Permiso")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Usado")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Su espacio aquí")}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.members.map((member) => (
                    <tr key={member.userId} className="border-t border-line align-middle">
                      <td className="min-w-0 px-3 py-2">
                        <span className="block truncate text-fg">{member.name || member.loginName}</span>
                        {member.orgName ? (
                          <span className="block truncate text-xs text-faint">{t("Por {0}", { 0: member.orgName })}</span>
                        ) : member.loginName && member.name ? (
                          <span className="block truncate text-xs text-faint">{member.loginName}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {state.canManage && member.accessEditable && member.shareId ? (
                          <select
                            value={member.access}
                            aria-label={t("Permiso de {0}", { 0: member.name || member.loginName })}
                            onChange={(event) => {
                              const access = event.target.value as "read" | "edit" | "admin";
                              void setMemberAccess({
                                data: { ...scope, userId: member.userId, memberShareId: member.shareId!, access },
                              }).then((result) => {
                                const failed = apply(result);
                                if (failed) setError(failed);
                              });
                            }}
                            className="h-9 w-full rounded-md border border-line bg-inset px-2 text-sm text-fg"
                          >
                            <option value="read">{t("Solo lectura")}</option>
                            <option value="edit">{t("Puede editar")}</option>
                            <option value="admin">{t("Administra")}</option>
                          </select>
                        ) : (
                          <span className="text-muted">{t(ACCESS_LABEL[member.access])}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-muted tabular-nums">
                        {formatBytes(member.used)}
                        {member.limit ? ` · ${Math.min(100, Math.round((member.used / member.limit) * 100))} %` : ""}
                      </td>
                      <td className="px-3 py-2">
                        {state.canManage ? (
                          <SizeField
                            value={member.limit}
                            label={t("Espacio de {0} aquí", { 0: member.name || member.loginName })}
                            onSave={async (bytes) =>
                              apply(await setMemberSpace({ data: { ...scope, userId: member.userId, bytes } }))
                            }
                          />
                        ) : (
                          <span className="block text-right text-muted">{member.limit === null ? t("Sin tope") : formatBytes(member.limit)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
