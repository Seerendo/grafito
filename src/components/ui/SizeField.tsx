import { useEffect, useState } from "react";
import { t } from "@/app/i18n";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

function split(bytes: number | null): { amount: string; unit: "MB" | "GB" } {
  if (bytes === null) return { amount: "", unit: "GB" };
  if (bytes >= GB && bytes % (GB / 10) === 0) return { amount: String(Math.round((bytes / GB) * 10) / 10), unit: "GB" };
  return { amount: String(Math.round(bytes / MB)), unit: "MB" };
}

/**
 * Un tope de espacio: cantidad y unidad (MB o GB). Vacío es «sin tope». Se
 * guarda al pulsar Enter o al salir del campo, si cambió; `onSave` devuelve el
 * error a mostrar, o `null`. Queda alineado al final de su celda, como piden
 * las tablas de espacio.
 */
export function SizeField({
  value,
  onSave,
  label,
  disabled = false,
}: {
  value: number | null;
  onSave: (bytes: number | null) => Promise<string | null>;
  label: string;
  disabled?: boolean;
}) {
  const initial = split(value);
  const [amount, setAmount] = useState(initial.amount);
  const [unit, setUnit] = useState<"MB" | "GB">(initial.unit);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = split(value);
    setAmount(next.amount);
    setUnit(next.unit);
  }, [value]);

  const save = async (nextUnit = unit) => {
    const clean = amount.trim().replace(",", ".");
    const number = Number(clean);
    if (clean && (!Number.isFinite(number) || number < 0)) {
      setError(t("Escribe un número."));
      return;
    }
    const bytes = clean ? Math.round(number * (nextUnit === "GB" ? GB : MB)) : null;
    if (bytes === value) return;
    setSaving(true);
    setError("");
    const failed = await onSave(bytes).catch(() => t("No se pudo guardar."));
    setSaving(false);
    if (failed) setError(failed);
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-end gap-1">
        <input
          inputMode="decimal"
          value={amount}
          disabled={disabled || saving}
          onChange={(event) => setAmount(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
          aria-label={label}
          placeholder={t("Sin tope")}
          className="h-9 w-24 min-w-0 rounded-md border border-line bg-inset px-2 text-sm text-fg tabular-nums placeholder:text-faint disabled:opacity-60"
        />
        <select
          value={unit}
          disabled={disabled || saving}
          onChange={(event) => {
            const next = event.target.value as "MB" | "GB";
            setUnit(next);
            if (amount.trim()) void save(next);
          }}
          aria-label={t("Unidad")}
          className="h-9 rounded-md border border-line bg-inset px-1.5 text-sm text-fg disabled:opacity-60"
        >
          <option value="MB">MB</option>
          <option value="GB">GB</option>
        </select>
      </div>
      {error ? <p className="mt-1 text-right text-xs text-danger">{t(error)}</p> : null}
    </div>
  );
}
