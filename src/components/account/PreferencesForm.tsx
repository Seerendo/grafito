import { useState } from "react";
import { flushSync } from "react-dom";
import { setLocale, t, useLocale } from "@/app/i18n";
import { Select } from "@/components/ui/Select";
import { LOCALES, isLocale, type Locale } from "@/domain/i18n";
import { savePreferences } from "@/server/session.functions";

/** Cambia el idioma con un fundido suave (View Transitions si el navegador las tiene). */
function switchLocale(locale: Locale): void {
  const start = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition;
  if (!start) {
    setLocale(locale);
    return;
  }
  start.call(document, () => flushSync(() => setLocale(locale)));
}

/** Cuenta → Preferencias: idioma de la interfaz (se guarda en la cuenta al pulsar Guardar). */
export function PreferencesForm() {
  const locale = useLocale();
  const [draft, setDraft] = useState<Locale>(locale);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await savePreferences({ data: { locale: draft } });
      switchLocale(draft);
    } catch {
      setError(t("No se pudo guardar."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="max-w-lg space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="block text-sm">
        <span className="text-muted">{t("Idioma")}</span>
        <Select
          className="mt-1"
          value={draft}
          onChange={(value) => {
            if (isLocale(value)) setDraft(value);
          }}
        >
          {LOCALES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </Select>
      </label>
      <button
        type="submit"
        disabled={saving || draft === locale}
        className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
      >
        {saving ? t("Guardando…") : t("Guardar")}
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
