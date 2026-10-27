import { ChevronsLeft, ChevronsRight, LayoutGrid, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { t } from "@/app/i18n";

/**
 * Barra lateral de secciones para pantallas de ajustes (Administración,
 * Cuenta). Se pliega a un riel estrecho, como el directorio de notas: el riel
 * conserva los iconos de las secciones y una flecha para volver a desplegarla.
 * Al volver a la pantalla aparece desplegada otra vez. En móvil no se muestra: la pantalla
 * usa un mosaico de iconos (`OptionGrid`) y un «Atrás».
 */

export type SettingsItem<T extends string> = { id: T; label: string; icon: LucideIcon };

export function SettingsNav<T extends string>({
  title,
  items,
  active,
  onSelect,
  allLabel,
  footer,
}: {
  title: string;
  items: SettingsItem<T>[];
  active: T | null;
  onSelect: (id: T | null) => void;
  /** Si se da, una primera entrada que vuelve a la vista general (`null`). */
  allLabel?: string;
  footer?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = () => setCollapsed((value) => !value);

  const entries: { id: T | null; label: string; icon: LucideIcon }[] = [
    ...(allLabel ? [{ id: null, label: allLabel, icon: LayoutGrid }] : []),
    ...items,
  ];

  if (collapsed) {
    return (
      <nav data-ui="rail" aria-label={title} className="hidden w-12 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-surface pt-2 md:flex">
        <button
          type="button"
          onClick={toggle}
          aria-label={t("Desplegar {0}", { 0: title.toLowerCase() })}
          title={t("Desplegar {0}", { 0: title.toLowerCase() })}
          className="mb-1 grid h-11 w-9 place-items-center rounded-md text-faint hover:text-fg"
        >
          <ChevronsRight className="size-4" />
        </button>
        {entries.map((entry) => {
          const Icon = entry.icon;
          const on = entry.id === active;
          return (
            <button
              key={entry.id ?? "__all"}
              type="button"
              onClick={() => onSelect(entry.id)}
              aria-label={t(entry.label)}
              aria-current={on ? "page" : undefined}
              title={t(entry.label)}
              className={`grid h-11 w-9 place-items-center rounded-md ${on ? "bg-elevated text-accent" : "text-muted hover:bg-elevated hover:text-fg"}`}
            >
              <Icon className="size-4" />
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav data-ui="sidebar" aria-label={title} className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2 pt-3 pr-2 pb-2 pl-4">
        <p className="flex-1 text-xs font-medium tracking-widest text-faint uppercase">{title}</p>
        <button
          type="button"
          onClick={toggle}
          aria-label={t("Plegar {0}", { 0: title.toLowerCase() })}
          title={t("Plegar {0}", { 0: title.toLowerCase() })}
          className="grid h-9 w-7 place-items-center rounded-md text-faint hover:text-fg"
        >
          <ChevronsLeft className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {entries.map((entry) => {
          const Icon = entry.icon;
          const on = entry.id === active;
          return (
            <button
              key={entry.id ?? "__all"}
              type="button"
              onClick={() => onSelect(entry.id)}
              aria-current={on ? "page" : undefined}
              className={`flex h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition-colors duration-200 ${
                on ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
              }`}
            >
              <Icon className={`size-4 shrink-0 ${on ? "text-accent" : ""}`} />
              <span className="truncate">{t(entry.label)}</span>
            </button>
          );
        })}
      </div>
      {footer ? <div className="mt-auto truncate px-4 py-4 text-xs text-faint">{footer}</div> : null}
    </nav>
  );
}
