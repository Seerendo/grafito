/**
 * Medidor de uso (0–100 %) para paneles de administración: pista redondeada y
 * visible, relleno proporcional y el porcentaje escrito, para que no se lea
 * como un campo de texto vacío cuando el valor es bajo.
 */
export function UsageMeter({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="mt-3 flex items-center gap-3 select-none">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-2 flex-1 overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="w-10 text-right text-xs text-muted tabular-nums">{value} %</span>
    </div>
  );
}
