import { useCallback, useEffect, useState } from "react";
import { intl, t } from "@/app/i18n";
import { Switch } from "@/components/ui/Switch";
import { TextAction } from "@/components/ui/TextAction";
import { mailAdminSave, mailAdminState } from "@/server/mailbox.functions";

/**
 * Administración → Cuentas de correo (mailbox.manage): how syncing is going across every account,
 * operational controls (pause everything, a provider or an account; retry failed jobs), the
 * policy, institutional server profiles and the OAuth applications. It shows no message content.
 */

type State = Extract<Awaited<ReturnType<typeof mailAdminState>>, { ok: true }>;
type Policy = State["policy"];
type SaveInput = {
  policy?: Partial<Policy>;
  oauth?: {
    provider: "gmail" | "microsoft";
    clientId: string;
    clientSecret: string;
    tenant: string;
  };
  profile?: { id?: string; name: string; host: string; port: number; domains: string[] };
  deleteProfile?: string;
  pauseAccount?: { id: string; paused: boolean };
  retryFailed?: boolean;
};

const MB = 1024 * 1024;
const field = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

function bytes(value: number): string {
  if (value < MB) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * MB) return `${(value / MB).toFixed(1)} MB`;
  return `${(value / (1024 * MB)).toFixed(1)} GB`;
}

export function MailboxBoard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(() => {
    void mailAdminState()
      .then((next) =>
        next.ok ? setState(next) : setError(t("Sin permiso para administrar el correo.")),
      )
      .catch(() => setError(t("No se pudo leer la configuración.")));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (data: SaveInput, message = "Guardado.") => {
    const answer = await mailAdminSave({ data }).catch(() => null);
    if (!answer?.ok) setError(answer?.error ?? t("No se pudo guardar."));
    else {
      setError("");
      setSaved(t(message));
      load();
    }
  };

  if (error && !state) return <p className="text-sm text-danger">{error}</p>;
  if (!state) return <p className="text-sm text-muted">{t("Cargando…")}</p>;
  const stats = state.stats;
  const worker = stats.workers[0];
  return (
    <div data-ui="mailbox-admin" className="flex flex-col gap-6">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {t(error)}
        </p>
      ) : null}
      {saved ? <p className="text-sm text-accent">{saved}</p> : null}
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          [t("Personas con cuentas"), stats.users],
          [
            t("Cuentas activas"),
            (stats.accounts.ok ?? 0) +
              (stats.accounts.syncing ?? 0) +
              (stats.accounts.connected ?? 0),
          ],
          [
            t("Cuentas con errores"),
            (stats.accounts.auth_error ?? 0) +
              (stats.accounts.expired ?? 0) +
              (stats.accounts.connection_error ?? 0) +
              (stats.accounts.error ?? 0) +
              (stats.accounts.retrying ?? 0),
          ],
          [t("Cuentas desconectadas"), stats.accounts.disconnected ?? 0],
          [t("Mensajes sincronizados"), stats.messages.toLocaleString(intl())],
          [t("Adjuntos guardados"), `${stats.attachmentsStored} · ${bytes(stats.attachmentBytes)}`],
          [t("Trabajos en cola"), stats.jobs.queued],
          [t("Trabajos en curso"), stats.jobs.running],
          [t("Fallidos (24 h)"), stats.jobs.failed24h],
          [
            t("Duración media de una sincronización"),
            `${(stats.jobs.avgSyncMs / 1000).toFixed(1)} s`,
          ],
          [t("Espera de la cola"), `${Math.round(stats.jobs.oldestQueuedMs / 1000)} s`],
          [
            t("Servicio mail-sync"),
            worker
              ? t("{0} en marcha · latido hace {1} s", {
                  0: stats.workers.length,
                  1: Math.round(worker.beatAgoMs / 1000),
                })
              : t("Sin conexión"),
          ],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-line bg-surface p-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        ))}
      </section>
      {stats.errorsByProvider.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("Errores por proveedor")}</h3>
          <ul className="text-sm text-muted">
            {stats.errorsByProvider.map((item) => (
              <li key={`${item.provider}-${item.status}`}>
                {item.provider} · {item.status}: {item.count}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-4">
          <Switch
            checked={state.policy.paused}
            label={t("Pausar toda la sincronización")}
            onChange={(paused) =>
              void save(
                { policy: { paused } },
                paused ? "Sincronización pausada." : "Sincronización reanudada.",
              )
            }
          />
          <TextAction
            onClick={() => void save({ retryFailed: true }, "Trabajos fallidos en cola otra vez.")}
          >
            {t("Reintentar trabajos fallidos")}
          </TextAction>
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-muted">
            {t("Cuentas ({0})", { 0: stats.accountList.length })}
          </summary>
          <ul className="mt-2 overflow-hidden rounded-lg border border-line">
            {stats.accountList.map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate">
                  {account.email}{" "}
                  <span className="text-xs text-faint">
                    · {account.owner} · {account.provider}
                  </span>
                </span>
                <span
                  className={`text-xs ${/error|expired|retrying/.test(account.status) ? "text-danger" : "text-faint"}`}
                >
                  {account.status}
                  {account.lastSyncAt
                    ? ` · ${new Date(account.lastSyncAt).toLocaleString(intl())}`
                    : ""}
                </span>
                <TextAction
                  onClick={() =>
                    void save({ pauseAccount: { id: account.id, paused: !account.paused } })
                  }
                >
                  {account.paused ? t("Reanudar") : t("Pausar")}
                </TextAction>
              </li>
            ))}
          </ul>
        </details>
      </section>
      <PolicyForm policy={state.policy} onSave={(policy) => void save({ policy })} />
      <Profiles state={state} onSave={save} />
      <OAuthApps state={state} onSave={save} />
    </div>
  );
}

function PolicyForm({
  policy,
  onSave,
}: {
  policy: Policy;
  onSave: (policy: Partial<Policy>) => void;
}) {
  const [draft, setDraft] = useState(policy);
  const number = (key: keyof Policy, label: string, scale = 1) => (
    <label className="flex flex-col gap-1 text-sm">
      {t(label)}
      <input
        type="number"
        min={0}
        value={Math.round(Number(draft[key]) / scale)}
        onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) * scale })}
        className={field}
      />
    </label>
  );
  const list = (key: "domains" | "imapHosts", label: string) => (
    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
      {t(label)}
      <input
        value={draft[key].join(", ")}
        onChange={(event) =>
          setDraft({
            ...draft,
            [key]: event.target.value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          })
        }
        className={field}
      />
    </label>
  );
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <h3 className="text-sm font-semibold">{t("Política")}</h3>
      <div className="flex flex-wrap gap-4 text-sm">
        {(["imap", "gmail", "microsoft"] as const).map((id) => (
          <label key={id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.providers.includes(id)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  providers: event.target.checked
                    ? [...draft.providers, id]
                    : draft.providers.filter((item) => item !== id),
                })
              }
            />
            {id === "imap"
              ? t("IMAP (Zimbra, Exchange, otros)")
              : id === "gmail"
                ? "Gmail"
                : "Microsoft 365 / Outlook"}
          </label>
        ))}
        {(["imap", "gmail", "microsoft"] as const).map((id) => (
          <label key={`pause-${id}`} className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={draft.pausedProviders.includes(id)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  pausedProviders: event.target.checked
                    ? [...draft.pausedProviders, id]
                    : draft.pausedProviders.filter((item) => item !== id),
                })
              }
            />
            {t("Pausar {0}", { 0: id })}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {list("domains", "Dominios permitidos (vacío: cualquiera)")}
        {list(
          "imapHosts",
          "Servidores IMAP permitidos además de los perfiles (vacío: cualquiera público; *.dominio vale)",
        )}
        {number("maxAccountsPerUser", "Cuentas por persona")}
        {number("minIntervalSeconds", "Frecuencia mínima (s)")}
        {number("defaultIntervalSeconds", "Frecuencia predeterminada (s)")}
        {number("maxHistoryDays", "Historial máximo (días)")}
        {number("maxAttachmentBytes", "Adjunto máximo (MB)", MB)}
        {number("prefetchAttachmentBytes", "Descarga anticipada hasta (MB)", MB)}
        {number("attachmentQuotaBytes", "Espacio de adjuntos por persona (MB, 0 sin límite)", MB)}
        {number("maxBodyBytes", "Cuerpo máximo guardado (KB)", 1024)}
        {number("concurrency", "Trabajos a la vez por servicio")}
        {number("providerConcurrency", "Trabajos a la vez por proveedor")}
      </div>
      <div className="flex flex-wrap gap-4">
        <Switch
          checked={draft.profilesOnly}
          onChange={(profilesOnly) => setDraft({ ...draft, profilesOnly })}
          label={t("Solo servidores de los perfiles")}
        />
        <Switch
          checked={draft.indexBodies}
          onChange={(indexBodies) => setDraft({ ...draft, indexBodies })}
          label={t("Buscar también en el texto de los mensajes")}
        />
      </div>
      <button
        type="submit"
        className="h-10 self-start rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
      >
        {t("Guardar política")}
      </button>
    </form>
  );
}

function Profiles({
  state,
  onSave,
}: {
  state: State;
  onSave: (data: SaveInput, message?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ name: "", host: "", port: 993, domains: "" });
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <h3 className="text-sm font-semibold">{t("Perfiles institucionales")}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {state.profiles.map((profile) => (
          <li key={profile.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate">
              {profile.name}{" "}
              <span className="text-xs text-faint">
                · {profile.host}:{profile.port} · {profile.domains.join(", ")}
              </span>
            </span>
            <TextAction tone="danger" onClick={() => void onSave({ deleteProfile: profile.id })}>
              {t("Borrar")}
            </TextAction>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-2 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            profile: {
              name: draft.name,
              host: draft.host,
              port: draft.port,
              domains: draft.domains
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            },
          }).then(() => setDraft({ name: "", host: "", port: 993, domains: "" }));
        }}
      >
        <input
          required
          aria-label={t("Nombre")}
          placeholder={t("Nombre (p. ej. Zimbra de la universidad)")}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          className={field}
        />
        <input
          required
          aria-label={t("Servidor IMAP")}
          placeholder="mail.universidad.edu"
          value={draft.host}
          onChange={(event) => setDraft({ ...draft, host: event.target.value })}
          className={field}
        />
        <select
          aria-label={t("Puerto")}
          value={draft.port}
          onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
          className={field}
        >
          <option value={993}>{t("993 · TLS")}</option>
          <option value={143}>{t("143 · STARTTLS")}</option>
        </select>
        <input
          aria-label={t("Dominios")}
          placeholder={t("Dominios: universidad.edu")}
          value={draft.domains}
          onChange={(event) => setDraft({ ...draft, domains: event.target.value })}
          className={field}
        />
        <button
          type="submit"
          className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated sm:col-span-4 sm:justify-self-start"
        >
          {t("Añadir perfil")}
        </button>
      </form>
    </section>
  );
}

function OAuthApps({
  state,
  onSave,
}: {
  state: State;
  onSave: (data: SaveInput, message?: string) => Promise<void>;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <h3 className="text-sm font-semibold">{t("Aplicaciones OAuth")}</h3>
      <p className="text-xs text-muted">
        {t("Dirección de retorno para registrar en Google y Microsoft:")}{" "}
        <code>{state.redirectUri}</code>
      </p>
      {(["gmail", "microsoft"] as const).map((provider) => (
        <OAuthForm key={provider} provider={provider} app={state.oauth[provider]} onSave={onSave} />
      ))}
    </section>
  );
}

function OAuthForm({
  provider,
  app,
  onSave,
}: {
  provider: "gmail" | "microsoft";
  app: { clientId: string; tenant: string; hasSecret: boolean };
  onSave: (data: SaveInput, message?: string) => Promise<void>;
}) {
  const [clientId, setClientId] = useState(app.clientId);
  const [secret, setSecret] = useState("");
  const [tenant, setTenant] = useState(app.tenant);
  return (
    <form
      className="grid gap-2 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ oauth: { provider, clientId, clientSecret: secret, tenant } }).then(() =>
          setSecret(""),
        );
      }}
    >
      <p className="text-sm font-medium sm:col-span-3">
        {provider === "gmail" ? "Google (Gmail)" : "Microsoft 365 / Outlook.com"}
      </p>
      <input
        aria-label={t("Client ID")}
        placeholder={t("Client ID")}
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
        className={field}
      />
      <input
        type="password"
        aria-label={t("Client secret")}
        placeholder={
          app.hasSecret ? t("Secreto guardado (escribe para cambiarlo)") : t("Client secret")
        }
        value={secret}
        autoComplete="new-password"
        onChange={(event) => setSecret(event.target.value)}
        className={field}
      />
      {provider === "microsoft" ? (
        <input
          aria-label={t("Tenant")}
          placeholder="common"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          className={field}
        />
      ) : (
        <span />
      )}
      <button
        type="submit"
        className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated sm:justify-self-start"
      >
        {t("Guardar")}
      </button>
    </form>
  );
}
