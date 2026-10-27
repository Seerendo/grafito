import { useEffect, useState, type FormEvent } from "react";
import { setAccountProfile, useAccountProfile } from "@/app/account-profile";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { mailPreferences, saveMailPreferences } from "@/server/mail.functions";
import { t } from "@/app/i18n";

/** Cuenta → Correo: la dirección de la persona y si quiere avisos de cambios. */
export function MailForm() {
  const profile = useAccountProfile();
  const [email, setEmail] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [mailOn, setMailOn] = useState(true);
  // LDAP, OAuth o SSO: el correo lo da el proveedor y no se edita aquí.
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void mailPreferences()
      .then((next) => {
        setEmail(next.email);
        setNotify(next.notifyChanges);
        setMailOn(next.mailOn);
        setProvider(next.provider);
      })
      .catch(() => setError(t("No se pudo leer la configuración.")));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const result = await saveMailPreferences({ data: { email: email ?? "", notifyChanges: notify } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccountProfile({ ...profile, contactEmail: result.email });
      setSaved(true);
    } catch {
      setError(t("No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  };

  if (email === null) return error ? <p className="text-sm text-danger">{t(error)}</p> : <p className="text-sm text-muted">{t("Cargando…")}</p>;

  return (
    <form onSubmit={(event) => void submit(event)} className="max-w-lg space-y-4">
      {provider ? (
        <div className="text-sm">
          <span className="text-muted">{t("Correo")}</span>
          <p className="mt-1 flex h-11 items-center rounded-md border border-line bg-inset px-3 text-fg">
            {email || <span className="text-faint">{t("Tu proveedor no da un correo")}</span>}
          </p>
        </div>
      ) : (
        <TextField label={t("Correo")} value={email} onChange={setEmail} autoComplete="email" type="email" optional />
      )}
      <div className="flex items-center gap-4 rounded-lg border border-line bg-surface px-4 py-2">
        <span className="min-w-0 flex-1 text-sm">{t("Avisarme por correo cuando cambien algo que comparto o que me compartieron")}</span>
        <Switch checked={notify} ariaLabel={t("Avisos de cambios por correo")} onChange={setNotify} />
      </div>
      {!mailOn ? <p className="text-sm text-muted">{t("El administrador todavía no configuró el correo.")}</p> : null}
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60">
          {busy ? t("Guardando…") : t("Guardar")}
        </button>
        {saved ? <span className="text-sm text-muted">{t("Guardado")}</span> : null}
      </div>
    </form>
  );
}
