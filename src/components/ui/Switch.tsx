/**
 * Toggle uses a padded flex track to contain its knob. label adds visible text; otherwise use
 * ariaLabel. Off colors are inset/line/muted; on colors are accent/accent-fg. These theme pairs
 * preserve contrast, including themes where line and fg coincide.
 */
export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-11 shrink-0 items-center gap-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border p-[2px] transition-colors ${
          checked ? "border-accent bg-accent" : "border-line bg-inset"
        }`}
      >
        <span
          className={`size-[18px] rounded-full shadow-sm transition-transform ${
            checked ? "translate-x-5 bg-accent-fg" : "translate-x-0 bg-muted"
          }`}
        />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}
