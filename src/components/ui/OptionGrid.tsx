import type { LucideIcon } from "lucide-react";
import { t } from "@/app/i18n";

/** Tarjetas para elegir una sección o subsección (ajustes, administración). */
export function OptionGrid<T extends string>({
  items,
  onPick,
}: {
  items: { id: T; label: string; icon: LucideIcon }[];
  onPick: (id: T) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item.id)}
            className="flex min-h-24 flex-col items-start gap-3 border border-line bg-surface p-4 text-left transition-colors hover:bg-elevated"
          >
            <Icon className="size-5 text-accent" />
            <span className="block font-serif text-xl leading-tight">{t(item.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
