import { useState, type FormEvent } from "react";
import { setAccountProfile } from "@/app/account-profile";
import { TextField } from "@/components/ui/TextField";
import { updateAccount } from "@/server/session.functions";
import { t } from "@/app/i18n";

/** Cuenta → Datos de la cuenta: el nombre. El correo va en Cuenta → Correo. */
export function ProfileForm({
  userId,
  initial,
  identity,
}: {
  userId: string;
  initial: { name: string };
  identity: { loginName: string; isAdmin: boolean; canAdmin: boolean };
}) {
  const [name, setName] = useState(initial.name);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const result = await updateAccount({ data: { name } });
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
      setError(t("No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-lg space-y-3">
      {identity.loginName ? (
        <p className="text-sm text-muted">
          {t("Usuario:")}{" "}<span className="text-fg">{identity.loginName}</span>
        </p>
      ) : null}
      <TextField label={t("Nombre")} value={name} onChange={setName} autoComplete="name" />
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
