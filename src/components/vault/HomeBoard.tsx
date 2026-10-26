import { File, FileText, Plus } from "lucide-react";
import { useMemo } from "react";
import { useVault } from "@/app/vault/store";
import { intl, t } from "@/app/i18n";

const RECENT = 12;

/** Raíz: lo último que se tocó en la bóveda. */
export function HomeBoard({ onCreate }: { onCreate?: () => void }) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const setActive = useVault((state) => state.setActive);
  const recent = useMemo(
    () => [...documents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT),
    [documents],
  );
  const place = (id: string | null) => portfolios.find((portfolio) => portfolio.id === id)?.name ?? t("Raíz");

  return (
    <div data-home className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="font-serif text-4xl font-semibold tracking-tight">{t("Raíz")}</h1>
          {onCreate ? (
            <button
              type="button"
              onClick={onCreate}
              className="ml-auto inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
            >
              <Plus className="size-4" />
              {t("Nueva nota")}
            </button>
          ) : null}
        </div>
        {recent.length > 0 ? (
          <section className="mt-6">
            <h2 className="text-xs font-medium tracking-widest text-faint uppercase">{t("Recientes")}</h2>
            <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
              {recent.map((document) => {
                const Icon = document.kind === "file" ? File : FileText;
                return (
                  <li key={document.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setActive(document.id)}
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
    </div>
  );
}

function formatWhen(ms: number): string {
  if (!ms) return "";
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short" }).format(new Date(ms));
}
