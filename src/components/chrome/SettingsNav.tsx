import {
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { t } from "@/app/i18n";

/**
 * Settings sidebar collapses to an icon rail and reopens expanded on reentry. Mobile uses
 * OptionGrid cards and back navigation instead.
 */

export type SettingsItem<T extends string> = { id: T; label: string; icon: LucideIcon };

export function SettingsNav<T extends string, S extends string = string>({
  title,
  items,
  active,
  onSelect,
  allLabel,
  footer,
  subItems = [],
  activeSub = null,
  onSelectSub,
}: {
  title: string;
  items: SettingsItem<T>[];
  active: T | null;
  onSelect: (id: T | null) => void;
  /** Optional first entry returns to the overview using null. */
  allLabel?: string;
  footer?: ReactNode;
  /** Expand the active section's subsections beneath it. */
  subItems?: SettingsItem<S>[];
  activeSub?: S | null;
  onSelectSub?: (id: S) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Click the active section to collapse its subsections; changing section or selecting a subsection expands them.
  const [subOpen, setSubOpen] = useState(true);
  useEffect(() => setSubOpen(true), [active, activeSub]);
  const toggle = () => setCollapsed((value) => !value);

  const entries: { id: T | null; label: string; icon: LucideIcon }[] = [
    ...(allLabel ? [{ id: null, label: allLabel, icon: LayoutGrid }] : []),
    ...items,
  ];

  if (collapsed) {
    return (
      <nav
        data-ui="rail"
        aria-label={title}
        className="hidden w-12 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-surface pt-2 md:flex"
      >
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
    <nav
      data-ui="sidebar"
      aria-label={title}
      className="hidden min-h-0 w-56 shrink-0 flex-col border-r border-line bg-surface md:flex"
    >
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
      <div
        data-ui="settings-entries"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {entries.map((entry) => {
          const Icon = entry.icon;
          const on = entry.id === active;
          const expandable = on && entry.id !== null && subItems.length > 0;
          const subs = expandable && subOpen ? subItems : [];
          return (
            <div key={entry.id ?? "__all"} className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => (expandable ? setSubOpen((value) => !value) : onSelect(entry.id))}
                aria-current={on ? "page" : undefined}
                aria-expanded={expandable ? subOpen : undefined}
                className={`flex h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition-colors duration-200 ${
                  on ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                }`}
              >
                <Icon className={`size-4 shrink-0 ${on ? "text-accent" : ""}`} />
                <span className="min-w-0 flex-1 truncate">{t(entry.label)}</span>
                {expandable ? (
                  <ChevronRight
                    className={`size-3.5 shrink-0 text-faint transition-transform ${subOpen ? "rotate-90" : ""}`}
                  />
                ) : null}
              </button>
              {subs.length > 0 ? (
                <div
                  data-ui="settings-subnav"
                  className="ml-5 flex flex-col gap-0.5 border-l border-line pl-2"
                >
                  {subs.map((sub) => {
                    const SubIcon = sub.icon;
                    const here = sub.id === activeSub;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => onSelectSub?.(sub.id)}
                        aria-current={here ? "page" : undefined}
                        className={`flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors duration-200 ${
                          here ? "bg-inset text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                        }`}
                      >
                        <SubIcon className={`size-3.5 shrink-0 ${here ? "text-accent" : ""}`} />
                        <span className="truncate">{t(sub.label)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {footer ? (
        <div className="shrink-0 truncate border-t border-line px-4 py-3 text-xs text-faint">
          {footer}
        </div>
      ) : null}
    </nav>
  );
}
