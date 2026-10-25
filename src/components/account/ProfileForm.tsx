import { useState, type FormEvent } from "react";
import { setAccountProfile } from "@/app/account-profile";
import { TextField } from "@/components/ui/TextField";
import { updateAccount } from "@/server/session.functions";

/** Cuenta → Datos de la cuenta: nombre y correo de contacto. */
export function ProfileForm({
  userId,
  initial,
  identity,
}: {
  userId: string;
  initial: { name: string; email: string };
  identity: { loginName: string; isAdmin: boolean; canAdmin: boolean };
}) {
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const result = await updateAccount({ data: { name, contactEmail: email } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccountProfile({
        userId,
        displayName: result.displayName,
        contactEmail: result.contactEmail,
        loginName: identity.loginName,
        isAdmin: identity.isAdmin,
        canAdmin: identity.canAdmin,
      });
      setSaved(true);
    } catch {
      setError("No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-lg space-y-3">
      {identity.loginName ? (
        <p className="text-sm text-muted">
          Usuario: <span className="text-fg">{identity.loginName}</span>
        </p>
      ) : null}
      <TextField label="Nombre" value={name} onChange={setName} autoComplete="name" />
      <TextField label="Correo" value={email} onChange={setEmail} autoComplete="email" type="email" optional />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60">
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {saved ? <span className="text-sm text-muted">Guardado</span> : null}
      </div>
    </form>
  );
}
