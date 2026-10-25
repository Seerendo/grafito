/** Campo de texto con etiqueta, el de los formularios de ingreso y cuenta. */
export function TextField({
  label,
  value,
  onChange,
  autoComplete,
  secret,
  type = "text",
  optional,
  autoFocus,
  title,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  /** Oculta lo escrito (`type="password"`). */
  secret?: boolean;
  type?: string;
  /** Sin `required`. */
  optional?: boolean;
  autoFocus?: boolean;
  title?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <input
        type={secret ? "password" : type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        title={title}
        required={!optional}
        className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3 text-fg outline-none"
      />
    </label>
  );
}
