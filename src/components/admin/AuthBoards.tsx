import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { authState, saveAuthProvider, testLdap, testSso } from "@/server/auth.functions";

/** Administración → Autenticación: LDAP, OAuth (Google, GitHub, Microsoft) y SSO (OIDC). */

type State = Extract<Awaited<ReturnType<typeof authState>>, { ok: true }>;
type Provider = State["providers"][number];
type Config = Record<string, string | boolean>;

function useAuthState() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    authState()
      .then((next) => {
        if (!next.ok) setError("Sin permiso para configurar la autenticación.");
        else setState(next);
      })
      .catch(() => setError("No se pudo leer la configuración."));
  useEffect(() => {
    void load();
  }, []);
  return { state, error, load };
}

function Loading({ error }: { error: string }) {
  return error ? <p className="text-sm text-danger">{error}</p> : <p className="text-sm text-muted">Cargando…</p>;
}

export function LdapPanel() {
  const { state, error } = useAuthState();
  if (!state) return <Loading error={error} />;
  const provider = state.providers.find((item) => item.id === "ldap")!;
  return (
    <ProviderForm
      provider={provider}
      roles={state.roles}
      fields={[
        { key: "url", label: "Servidor", placeholder: "ldap://ldap.empresa.com:389 o ldaps://…:636" },
        { key: "bindDn", label: "DN de la cuenta de servicio", placeholder: "cn=lector,dc=empresa,dc=com (vacío: anónimo)" },
        { key: "bindPassword", label: "Contraseña de la cuenta de servicio", secret: true },
        { key: "baseDn", label: "Base de búsqueda", placeholder: "ou=people,dc=empresa,dc=com" },
        {
          key: "userFilter",
          label: "Filtro de usuario",
          placeholder: "(uid={{username}})",
        },
        { key: "nameAttr", label: "Atributo del nombre", placeholder: "cn o displayName" },
        { key: "emailAttr", label: "Atributo del correo", placeholder: "mail" },
        { key: "startTls", label: "Usar StartTLS", toggle: true },
        { key: "allowInsecureTls", label: "Aceptar certificados no verificados (solo pruebas)", toggle: true },
      ]}
      test={(config) => <LdapTest config={config} />}
    />
  );
}

function LdapTest({ config }: { config: Config }) {
  const [probe, setProbe] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          value={probe}
          onChange={(event) => setProbe(event.target.value)}
          placeholder="Usuario para buscar (opcional)"
          aria-label="Usuario para la prueba"
          className="h-11 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-sm"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setResult(null);
            void testLdap({ data: { config, probeUser: probe } })
              .then((next) => setResult(next.ok ? { ok: true, text: next.message } : { ok: false, text: next.error }))
              .catch(() => setResult({ ok: false, text: "No se pudo probar." }))
              .finally(() => setBusy(false));
          }}
          className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated disabled:opacity-60"
        >
          {busy ? "Probando…" : "Probar conexión"}
        </button>
      </div>
      {result ? <p className={`text-sm ${result.ok ? "text-muted" : "text-danger"}`}>{result.text}</p> : null}
    </div>
  );
}

export function OAuthPanel() {
  const { state, error } = useAuthState();
  if (!state) return <Loading error={error} />;
  const items: { id: "google" | "github" | "microsoft"; name: string }[] = [
    { id: "google", name: "Google" },
    { id: "github", name: "GitHub" },
    { id: "microsoft", name: "Microsoft" },
  ];
  return (
    <div className="space-y-8">
      {items.map((item) => (
        <section key={item.id}>
          <h2 className="font-serif text-2xl">{item.name}</h2>
          <ProviderForm
            provider={state.providers.find((provider) => provider.id === item.id)!}
            roles={state.roles}
            callback={state.callbacks[item.id]}
            fields={[
              { key: "clientId", label: "Client ID" },
              { key: "clientSecret", label: "Client secret", secret: true },
              ...(item.id === "microsoft"
                ? [{ key: "tenantId", label: "Tenant", placeholder: "common, organizations o el ID de tu inquilino" }]
                : []),
            ]}
          />
        </section>
      ))}
    </div>
  );
}

export function SsoPanel() {
  const { state, error } = useAuthState();
  if (!state) return <Loading error={error} />;
  return (
    <ProviderForm
      provider={state.providers.find((provider) => provider.id === "sso")!}
      roles={state.roles}
      callback={state.callbacks.sso}
      fields={[
        { key: "label", label: "Texto del botón", placeholder: "Keycloak" },
        {
          key: "issuer",
          label: "Emisor (issuer)",
          placeholder: "https://sso.empresa.com/realms/grafito",
        },
        { key: "clientId", label: "Client ID" },
        { key: "clientSecret", label: "Client secret", secret: true },
        { key: "scopes", label: "Alcances", placeholder: "openid profile email" },
      ]}
      test={(config) => <SsoTest issuer={String(config.issuer ?? "")} />}
    />
  );
}

function SsoTest({ issuer }: { issuer: string }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy || !issuer}
        onClick={() => {
          setBusy(true);
          setResult(null);
          void testSso({ data: { issuer } })
            .then((next) => setResult(next.ok ? { ok: true, text: next.message } : { ok: false, text: next.error }))
            .catch(() => setResult({ ok: false, text: "Escribe una URL válida." }))
            .finally(() => setBusy(false));
        }}
        className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated disabled:opacity-60"
      >
        {busy ? "Probando…" : "Probar emisor"}
      </button>
      {result ? <p className={`text-sm break-all ${result.ok ? "text-muted" : "text-danger"}`}>{result.text}</p> : null}
    </div>
  );
}

type FieldSpec = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  toggle?: boolean;
};

function ProviderForm({
  provider,
  roles,
  fields,
  callback,
  test,
}: {
  provider: Provider;
  roles: State["roles"];
  fields: FieldSpec[];
  callback?: string;
  test?: (config: Config) => ReactNode;
}) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [config, setConfig] = useState<Config>(provider.config as Config);
  const [defaultRole, setDefaultRole] = useState(provider.defaultRole);
  const [domains, setDomains] = useState(provider.allowedDomains.join(", "));
  const [hasSecret, setHasSecret] = useState(provider.hasSecret);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await saveAuthProvider({
        data: { id: provider.id, enabled, config, defaultRole, allowedDomains: domains },
      });
      if (!result.ok) {
        setStatus({ ok: false, text: result.error });
        return;
      }
      setConfig(result.provider.config as Config);
      setHasSecret(result.provider.hasSecret);
      setStatus({ ok: !result.warning, text: result.warning || "Guardado. Ya se aplica en el ingreso." });
    } catch {
      setStatus({ ok: false, text: "No se pudo guardar." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-3 space-y-4 rounded-lg border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Switch label="Activado" checked={enabled} onChange={setEnabled} />
      {callback ? <CopyLine label="Dirección de retorno" value={callback} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map((field) =>
          field.toggle ? (
            <div key={field.key} className="md:col-span-2">
              <Switch
                label={field.label}
                checked={Boolean(config[field.key])}
                onChange={(value) => setConfig({ ...config, [field.key]: value })}
              />
            </div>
          ) : (
            <label key={field.key} className="block text-sm">
              <span className="text-muted">{field.label}</span>
              <input
                type={field.secret ? "password" : "text"}
                value={String(config[field.key] ?? "")}
                onChange={(event) => setConfig({ ...config, [field.key]: event.target.value })}
                placeholder={field.secret && hasSecret ? "•••••••• (guardado; vacío lo conserva)" : field.placeholder}
                autoComplete={field.secret ? "new-password" : "off"}
                spellCheck={false}
                className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3 text-fg"
              />
            </label>
          ),
        )}
        <label className="block text-sm">
          <span className="text-muted">Rol de las cuentas nuevas</span>
          <Select value={defaultRole} onChange={setDefaultRole} className="mt-1">
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-sm">
          <span className="text-muted">Dominios de correo permitidos</span>
          <input
            value={domains}
            onChange={(event) => setDomains(event.target.value)}
            placeholder="empresa.com, filial.com (vacío: cualquiera)"
            spellCheck={false}
            className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3 text-fg"
          />
        </label>
      </div>
      {test ? test(config) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" disabled={busy} className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60">
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {status ? <p className={`text-sm ${status.ok ? "text-muted" : "text-danger"}`}>{status.text}</p> : null}
      </div>
    </form>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="text-sm">
      <span className="text-muted">{label}</span>
      <div className="mt-1 flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs text-fg">{value}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          aria-label="Copiar"
          className="shrink-0 text-faint hover:text-fg"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}
