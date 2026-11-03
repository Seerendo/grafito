/**
 * Administration usage meter with visible rounded track, proportional fill and numeric
 * percentage so low values do not resemble empty text fields.
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
