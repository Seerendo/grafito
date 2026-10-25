import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/TextField";
import { changePassword, signInWithPassword } from "@/lib/auth/password";

/**
 * Cuenta → Contraseña. Tras cambiarla se vuelve a entrar con la nueva para
 * renovar la sesión. Las cuentas que entran por LDAP, OAuth o SSO no tienen
 * contraseña propia en Grafito: se cambia en su proveedor.
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
      setError("La nueva contraseña necesita al menos 8 caracteres.");
      return;
    }
    if (next === current) {
      setError("Tiene que ser distinta.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!(await changePassword(current, next))) {
        setError("No se cambió. Revisa la contraseña actual (si entras por LDAP, OAuth o SSO, cámbiala allí).");
        return;
      }
      if (loginEmail) await signInWithPassword(loginEmail, next);
      setCurrent("");
      setNext("");
      setSaved(true);
    } catch {
      setError("No se pudo cambiar la contraseña.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-lg space-y-3">
      <TextField label="Contraseña actual" value={current} onChange={setCurrent} autoComplete="current-password" secret />
      <TextField
        label="Nueva contraseña"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        secret
        title="Al menos 8 caracteres, distinta de la actual"
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60">
          {busy ? "Guardando…" : "Cambiar contraseña"}
        </button>
        {saved ? <span className="text-sm text-muted">Contraseña actualizada</span> : null}
      </div>
    </form>
  );
}
