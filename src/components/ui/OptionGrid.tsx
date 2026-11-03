import type { LucideIcon } from "lucide-react";
import { t } from "@/app/i18n";

/**
 * Section/subsection icon grid. Equal-size cards fill rows from the left, with centered icons
 * and names below.
 */
export function OptionGrid<T extends string>({
  items,
  onPick,
}: {
  items: { id: T; label: string; icon: LucideIcon }[];
  onPick: (id: T) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item.id)}
            className="flex min-h-32 flex-col items-center gap-3 rounded-lg border border-line bg-surface px-3 pt-6 pb-4 text-center transition-colors hover:bg-elevated"
          >
            <Icon className="size-8 shrink-0 text-accent" strokeWidth={1.5} aria-hidden="true" />
            {/* Reserve two text lines to align icons across each row. */}
            <span className="line-clamp-2 min-h-[2.5rem] text-sm leading-5 font-medium text-fg">
              {t(item.label)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
