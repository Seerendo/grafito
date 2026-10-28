import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { SizeField } from "@/components/ui/SizeField";
import { formatBytes } from "@/domain/space";
import { setDefaultUserSpace, setPortfolioSpace, setUserSpace, spaceOverview } from "@/server/space.functions";
import { t } from "@/app/i18n";

type Overview = Extract<Awaited<ReturnType<typeof spaceOverview>>, { ok: true }>;

/**
 * Administración → Usuarios y permisos (permiso `space.manage`): «Espacio por
 * usuario» (el de por defecto y el de cada uno) y «Espacio por portafolio».
 * Lo que cada usuario puede usar dentro de un portafolio lo reparten su dueño
 * o quien lo administra (diálogo «Espacio y permisos»). Las columnas tienen
 * ancho fijo para que las tablas queden alineadas.
 */
export function QuotaBoard({ view }: { view: "users" | "portfolios" }) {
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  const load = async () => {
    const result = await spaceOverview().catch(() => null);
    if (result?.ok) setData(result);
    else setFailed(true);
  };

  useEffect(() => {
    void load();
  }, []);

  if (failed) return <p className="text-sm text-danger">{t("No se pudo leer el espacio.")}</p>;
  if (!data) return <p className="text-sm text-faint">{t("Cargando…")}</p>;

  const needle = query.trim().toLowerCase();
  const users = data.users.filter((user) => !needle || `${user.name} ${user.loginName}`.toLowerCase().includes(needle));
  const portfolios = data.portfolios.filter(
    (portfolio) => !needle || `${portfolio.ownerName} ${portfolio.path}`.toLowerCase().includes(needle),
  );
  const saved = (result: { ok: boolean; error?: string }) => {
    if (!result.ok) return result.error ?? "No se pudo guardar.";
    void load();
    return null;
  };

  return (
    <div data-ui="quota-board" className="space-y-6">
      {view === "users" ? (
      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-4">
        <span className="min-w-0 flex-1 text-sm text-fg">{t("Espacio de cada usuario, si no tiene uno propio")}</span>
        <SizeField
          value={data.defaultLimit}
          label={t("Espacio por defecto")}
          onSave={async (bytes) => saved(await setDefaultUserSpace({ data: { bytes } }))}
        />
      </section>
      ) : null}

      <label className="flex h-10 items-center gap-2 rounded-md border border-line bg-inset px-3 text-sm text-muted">
        <Search className="size-4 shrink-0" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Filtrar")}
          className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-faint"
        />
      </label>

      {view === "users" ? (
      <section>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[34rem] table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-28" />
              <col className="w-56" />
            </colgroup>
            <thead className="bg-inset text-left text-xs text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">{t("Usuario")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("Usado")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("Espacio")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-line align-middle">
                  <td className="min-w-0 px-3 py-2">
                    <span className="block truncate text-fg">{user.name || user.loginName}</span>
                    {user.loginName && user.name ? <span className="block truncate text-xs text-faint">{user.loginName}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right text-muted tabular-nums">{formatBytes(user.used)}</td>
                  <td className="px-3 py-2">
                    <SizeField
                      value={user.limit}
                      label={t("Espacio de {0}", { 0: user.name || user.loginName })}
                      onSave={async (bytes) => saved(await setUserSpace({ data: { userId: user.id, bytes } }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      ) : (
      <section>
        {portfolios.length === 0 ? (
          <p className="text-sm text-faint italic">{t("Nada coincide.")}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[42rem] table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-40" />
                <col className="w-28" />
                <col className="w-56" />
              </colgroup>
              <thead className="bg-inset text-left text-xs text-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("Portafolio")}</th>
                  <th className="px-3 py-2 font-medium">{t("Dueño")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Usado")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Espacio")}</th>
                </tr>
              </thead>
              <tbody>
                {portfolios.map((portfolio) => (
                  <tr key={`${portfolio.ownerId}/${portfolio.id}`} className="border-t border-line align-middle">
                    <td className="truncate px-3 py-2 text-fg" title={portfolio.path}>{portfolio.path}</td>
                    <td className="truncate px-3 py-2 text-muted">{portfolio.ownerName}</td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">{formatBytes(portfolio.used)}</td>
                    <td className="px-3 py-2">
                      <SizeField
                        value={portfolio.limit}
                        label={t("Espacio de {0}", { 0: portfolio.path })}
                        onSave={async (bytes) =>
                          saved(
                            await setPortfolioSpace({ data: { portfolioId: portfolio.id, ownerId: portfolio.ownerId, bytes } }),
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </div>
  );
}
