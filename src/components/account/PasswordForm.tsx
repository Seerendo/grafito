import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/TextField";
import { changePassword, signInWithPassword } from "@/lib/auth/password";
import { t } from "@/app/i18n";

/**
 * After changing a local password, sign in again to renew the session. LDAP, OAuth and SSO
 * users change passwords at their provider.
 */
export function PasswordForm({ loginEmail }: { loginEmail: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (next.length < 8) {
      setError(t("La nueva contraseña necesita al menos 8 caracteres."));
      return;
    }
    if (next === current) {
      setError(t("Tiene que ser distinta."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!(await changePassword(current, next))) {
        setError(
          t(
            "No se cambió. Revisa la contraseña actual (si entras por LDAP, OAuth o SSO, cámbiala allí).",
          ),
        );
        return;
      }
      if (loginEmail) await signInWithPassword(loginEmail, next);
      setCurrent("");
      setNext("");
      setSaved(true);
    } catch {
      setError(t("No se pudo cambiar la contraseña."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-lg space-y-3">
      <TextField
        label={t("Contraseña actual")}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
        secret
      />
      <TextField
        label={t("Nueva contraseña")}
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        secret
        title={t("Al menos 8 caracteres, distinta de la actual")}
      />
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {busy ? t("Guardando…") : t("Cambiar contraseña")}
        </button>
        {saved ? <span className="text-sm text-muted">{t("Contraseña actualizada")}</span> : null}
      </div>
    </form>
  );
}
