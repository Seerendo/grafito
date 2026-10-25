/**
 * Interruptor de activar/desactivar. La pista es flex con relleno fijo y la
 * bolita se desplaza dentro de ella, así que nunca se sale del recuadro.
 * Con `label` muestra el texto al lado; sin él, usa `ariaLabel`.
 *
 * Colores por pares que cada tema ya hace contrastar: apagado, pista `inset`
 * con borde `line` y bolita `muted`; encendido, pista `accent` y bolita
 * `accent-fg`. (En temas como Folleto, `line` y `fg` son el mismo negro: no
 * se pueden usar juntos.)
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
