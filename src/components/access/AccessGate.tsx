import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { changePassword, signInWithPassword as passwordSignIn } from "@/lib/auth/password";
import { ldapSignIn, providerErrorMessage, signInWithProvider } from "@/lib/auth/external";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { authMethods } from "@/server/auth.functions";
import { TextField } from "@/components/ui/TextField";
import { clearHeldAdmin, heldAdminId, rememberAdmin } from "@/app/vault-hold";
import { clearAccountProfile, setAccountProfile } from "@/app/account-profile";
import { clearPermissions, setPermissions } from "@/app/permissions";
import { STRONG_PASSWORD, emailForUsername } from "@/server/platform";
import { accessState, createInitialAdmin, markPasswordChanged, sessionProfile } from "@/server/admin.functions";
import { getLocale, setLocale, t } from "@/app/i18n";

const AppAdminContext = createContext(false);

export function useAppAdmin(): boolean {
  return useContext(AppAdminContext);
}

type Install = { installed: boolean; loginName: string; mustChangePassword: boolean };
type Account = {
  userId: string;
  isAdmin: boolean;
  canAdmin: boolean;
  mustChangePassword: boolean;
  loginName: string;
};

async function signInWithPassword(email: string, password: string): Promise<void> {
  if (!(await passwordSignIn(email, password))) throw new Error("rejected");
}

export function AccessGate({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  const [install, setInstall] = useState<Install | null>(null);
  const [installError, setInstallError] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [usedPassword, setUsedPassword] = useState("");
  const userId = user?.id;

  const refreshInstall = () =>
    accessState()
      .then((next) => {
        setInstall(next);
        setInstallError("");
      })
      .catch(() => setInstallError(t("No se pudo leer si el sistema ya está configurado.")));

  useEffect(() => {
    void refreshInstall();
  }, []);

  useEffect(() => {
    if (isPending || userId) return;
    clearHeldAdmin();
    clearAccountProfile();
    clearPermissions();
    setAccount(null);
  }, [isPending, userId]);

  useEffect(() => {
    if (!userId) return;
    const held = heldAdminId();
    if (
      held &&
      held !== userId &&
      account?.isAdmin &&
      !account.mustChangePassword &&
      account.userId === held
    ) {
      return;
    }
    let cancelled = false;
    void sessionProfile()
      .then((next) => {
        if (cancelled) return;
        setPermissions(next);
        // El idioma elegido en otra sesión sigue al usuario.
        if (next.locale && next.locale !== getLocale()) setLocale(next.locale);
        if (!next.isAdmin) {
          if (held && held !== userId && account?.userId === held) return;
          clearHeldAdmin();
          setAccountProfile({
            userId,
            displayName: next.displayName || t("Cuenta"),
            contactEmail: next.contactEmail,
            loginName: next.loginName,
            isAdmin: false,
            canAdmin: next.canAdmin,
          });
          setAccount({
            userId,
            isAdmin: false,
            canAdmin: next.canAdmin,
            mustChangePassword: false,
            loginName: next.loginName,
          });
          return;
        }
        if (next.mustChangePassword) clearHeldAdmin();
        else rememberAdmin(userId);
        setAccountProfile({
          userId,
          displayName: next.displayName,
          contactEmail: next.contactEmail,
          loginName: next.loginName || "admin",
          isAdmin: true,
          canAdmin: true,
        });
        setAccount({
          userId,
          isAdmin: true,
          canAdmin: true,
          mustChangePassword: next.mustChangePassword,
          loginName: next.loginName || "admin",
        });
      })
      .catch(() => {
        if (cancelled || heldAdminId()) return;
        setAccount({ userId, isAdmin: false, canAdmin: false, mustChangePassword: false, loginName: "" });
      });
    return () => {
      cancelled = true;
    };
    // account is read only to ignore a gate-identity flicker; re-running on it would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (installError) {
    return (
      <Shell>
        <p className="text-sm text-danger">{t(installError)}</p>
      </Shell>
    );
  }

  const live = user && account && account.userId === user.id ? account : null;
  const heldVault =
    account?.isAdmin &&
    !account.mustChangePassword &&
    heldAdminId() === account.userId &&
    user != null &&
    user.id !== account.userId;

  if (live && !live.mustChangePassword) {
    return <AppAdminContext.Provider value={live.isAdmin}>{children}</AppAdminContext.Provider>;
  }

  if (heldVault) {
    return <AppAdminContext.Provider value={true}>{children}</AppAdminContext.Provider>;
  }

  if (live?.mustChangePassword) {
    return (
      <ChangePassword
        loginName={live.loginName}
        userId={live.userId}
        currentDefault={usedPassword}
        onChanged={() => {
          rememberAdmin(live.userId);
          setAccount({ ...live, mustChangePassword: false });
        }}
      />
    );
  }

  if (!install || isPending || (user && !account)) {
    return (
      <Shell>
        <p className="text-sm text-muted">{t("Cargando…")}</p>
      </Shell>
    );
  }

  if (!install.installed) {
    return <SetupForm onSignedIn={setUsedPassword} onInstalled={() => void refreshInstall()} />;
  }

  return <LoginForm onSignedIn={setUsedPassword} />;
}

function SetupForm({
  onSignedIn,
  onInstalled,
}: {
  onSignedIn: (password: string) => void;
  onInstalled: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await createInitialAdmin({ data: { username, password } });
      if (!created.ok) {
        setError(created.error);
        onInstalled();
        return;
      }
      await signInWithPassword(created.email, password);
      onSignedIn(password);
      onInstalled();
    } catch {
      setError(t("La cuenta quedó creada, pero no se pudo entrar. Vuelve a intentarlo."));
      onInstalled();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <p className="text-xs font-medium tracking-widest text-faint uppercase">{t("Grafito")}</p>
      <h1 className="mt-2 font-serif text-3xl">{t("Primera vez")}</h1>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField label={t("Usuario")} value={username} onChange={setUsername} autoComplete="off" autoFocus />
        <TextField label={t("Contraseña")} value={password} onChange={setPassword} autoComplete="new-password" secret />
        {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {busy ? t("Creando…") : t("Crear administrador")}
        </button>
      </form>
    </Shell>
  );
}

type Methods = Awaited<ReturnType<typeof authMethods>>;

function LoginForm({ onSignedIn }: { onSignedIn: (password: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [methods, setMethods] = useState<Methods | null>(null);
  const [mode, setMode] = useState<"local" | "ldap">("local");

  useEffect(() => {
    void authMethods()
      .then(setMethods)
      .catch(() => setMethods(null));
    // Better Auth vuelve aquí con `?error=` si falla un proveedor externo.
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(providerErrorMessage(code));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "ldap") {
        const result = await ldapSignIn(username.trim(), password);
        if (!result.ok) setError(result.error);
        return;
      }
      const email = emailForUsername(username);
      if (!email) {
        setError(t("Ese usuario no es válido."));
        return;
      }
      await signInWithPassword(email, password);
      onSignedIn(password);
    } catch {
      setError(t("Usuario o contraseña incorrectos."));
    } finally {
      setBusy(false);
    }
  };

  const external = [
    ...(methods?.oauth ?? []),
    ...(methods?.sso ? [{ id: "sso" as const, label: methods.sso.label }] : []),
  ];

  return (
    <Shell>
      <p className="text-xs font-medium tracking-widest text-faint uppercase">{t("Grafito")}</p>
      <h1 className="mt-2 font-serif text-3xl">{t("Entrar")}</h1>
      {methods?.ldap ? (
        <div role="tablist" aria-label={t("Tipo de cuenta")} className="mt-5 grid grid-cols-2 rounded-md border border-line p-0.5 text-sm">
          {(
            [
              ["local", t("Cuenta de Grafito")],
              ["ldap", t("Directorio (LDAP)")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => {
                setMode(id);
                setError("");
              }}
              className={`h-9 rounded ${mode === id ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField
          label={mode === "ldap" ? t("Usuario del directorio") : t("Usuario")}
          value={username}
          onChange={setUsername}
          autoComplete="username"
          autoFocus
        />
        <TextField label={t("Contraseña")} value={password} onChange={setPassword} autoComplete="current-password" secret />
        {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {busy ? t("Entrando…") : t("Entrar")}
        </button>
      </form>
      {external.length > 0 ? (
        <div className="mt-5">
          <p className="flex items-center gap-3 text-xs text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
            {t("o continúa con")}
          </p>
          <div className="mt-3 grid gap-2">
            {external.map((provider) => (
              <button
                key={provider.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void signInWithProvider(provider.id).then((message) => {
                    if (message) {
                      setError(message);
                      setBusy(false);
                    }
                  });
                }}
                className="h-11 w-full rounded-md border border-line text-sm text-fg hover:bg-elevated disabled:opacity-60"
              >
                {provider.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Shell>
  );
}

function ChangePassword({
  loginName,
  userId,
  currentDefault,
  onChanged,
}: {
  loginName: string;
  userId: string;
  currentDefault: string;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState(currentDefault);
  const [nextPassword, setNextPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (nextPassword.length < STRONG_PASSWORD) {
      setError(t("La nueva contraseña necesita al menos {0} caracteres.", { 0: STRONG_PASSWORD }));
      return;
    }
    if (nextPassword === currentPassword) {
      setError(t("Tiene que ser distinta de la contraseña inicial."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!(await changePassword(currentPassword, nextPassword))) {
        setError(t("No se cambió. Revisa la contraseña actual."));
        return;
      }
      const marked = await markPasswordChanged();
      if (!marked.ok) {
        setError(t("La clave cambió, pero no se pudo cerrar el primer ingreso."));
        return;
      }
      const email = emailForUsername(loginName);
      if (!email) {
        setError(t("No se pudo entrar."));
        return;
      }
      try {
        await signInWithPassword(email, nextPassword);
      } catch {
        /* la sesión del cambio puede seguir valiendo */
      }
      rememberAdmin(userId);
      onChanged();
    } catch {
      setError(t("No se pudo cambiar la contraseña."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <p className="text-xs font-medium tracking-widest text-faint uppercase">{loginName}</p>
      <h1 className="mt-2 font-serif text-3xl">{t("Cambia la contraseña")}</h1>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <TextField
          label={t("Contraseña actual")}
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
          secret
        />
        <TextField
          label={t("Nueva contraseña")}
          value={nextPassword}
          onChange={setNextPassword}
          autoComplete="new-password"
          secret
          autoFocus
          title={t("Al menos 8 caracteres, distinta de la actual")}
        />
        {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {busy ? t("Guardando…") : t("Guardar y entrar")}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-8 text-fg">
      <div className="w-full max-w-sm border border-line bg-surface p-6">{children}</div>
    </main>
  );
}
