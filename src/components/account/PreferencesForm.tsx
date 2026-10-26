import { useState } from "react";
import { setLocale, t, useLocale } from "@/app/i18n";
import { Select } from "@/components/ui/Select";
import { LOCALES, isLocale } from "@/domain/i18n";
import { savePreferences } from "@/server/session.functions";

/** Cuenta → Preferencias: idioma de la interfaz (se guarda en la cuenta). */
export function PreferencesForm() {
  const locale = useLocale();
  const [error, setError] = useState("");

  return (
    <div className="max-w-lg space-y-3">
      <label className="block text-sm">
        <span className="text-muted">{t("Idioma")}</span>
        <Select
          className="mt-1"
          value={locale}
          onChange={(value) => {
            if (!isLocale(value)) return;
            setError("");
            setLocale(value);
            void savePreferences({ data: { locale: value } }).catch(() => setError(t("No se pudo guardar.")));
          }}
        >
          {LOCALES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </Select>
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
