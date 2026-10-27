import type { LucideIcon } from "lucide-react";
import { t } from "@/app/i18n";

/**
 * Mosaico de iconos para elegir una sección o subsección (ajustes,
 * administración), como los iconos medianos de un explorador de archivos:
 * cada opción en su propio recuadro, con el icono en el centro y el nombre
 * centrado debajo. La rejilla llena cada fila desde la izquierda con
 * recuadros del mismo tamaño.
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
            {/* Sitio para dos líneas: los iconos de una fila quedan a la misma altura. */}
            <span className="line-clamp-2 min-h-[2.5rem] text-sm leading-5 font-medium text-fg">{t(item.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
