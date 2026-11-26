import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { intl, t } from "@/app/i18n";
import { Switch } from "@/components/ui/Switch";
import { TextAction } from "@/components/ui/TextAction";
import {
  mailAccountAction,
  mailAddImap,
  mailFolderSync,
  mailOAuthFinish,
  mailOAuthStart,
  mailState,
  mailUpdateAccount,
} from "@/server/mailbox.functions";
import { statusLabel } from "./status";

/**
 * Cuenta → Cuentas de correo: connect (IMAP with a password, or Gmail and Microsoft through their own
 * sign-in), and for each account its state, sync settings, folders, the MCP permission, new
 * credentials, disconnecting and deleting the local copy. Passwords are sent once and never shown
 * again.
 */

type State = Extract<Awaited<ReturnType<typeof mailState>>, { ok: true }>;
type Account = State["accounts"][number];

/**
 * Known servers: Gmail, Yahoo and iCloud take IMAP and SMTP with an app password (Gmail through
 * OAuth too when the server has its application). Zimbra and others: the person writes them.
 */
const PRESETS = [
  {
    id: "imap",
    label: "Zimbra u otro servidor IMAP",
    host: "",
    port: 993,
    smtpHost: "",
    smtpPort: 587,
  },
  {
    id: "gmail",
    label: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
  },
  {
    id: "yahoo",
    label: "Yahoo",
    host: "imap.mail.yahoo.com",
    port: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
  },
  {
    id: "icloud",
    label: "iCloud",
    host: "imap.mail.me.com",
    port: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
  },
];

const INTERVALS = [120, 300, 600, 1800, 3600, 21_600];
const HISTORY = [0, 7, 30, 90, 180, 365, 730, 3650];

const allowedHistory = (max: number) =>
  HISTORY.filter((days) => (max === 0 ? true : days > 0 && days <= max));

const historyLabel = (days: number) =>
  days === 0 ? t("Todo el historial") : t("Últimos {0} días", { 0: days });

const input = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

export function MailAccounts() {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    const answer = await mailState().catch(() => null);
    if (!answer) setProblem("No se pudo leer la configuración.");
    else if (!answer.ok) setProblem("El correo no está disponible.");
    else {
      setProblem("");
      setState(answer);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // Back from Google or Microsoft: the session finishes the authorization.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("oauth_code");
    const stateParam = params.get("oauth_state");
    const error = params.get("oauth_error");
    if (!code && !error) return;
    window.history.replaceState(null, "", "/account?section=mailboxes");
    if (error || !code || !stateParam) {
      setNotice("El proveedor no autorizó la cuenta.");
      return;
    }
    void mailOAuthFinish({ data: { code, state: stateParam } }).then((answer) => {
      setNotice(answer.ok ? "Cuenta conectada. La sincronización empezó." : answer.error);
      void load();
    });
  }, [load]);

  if (problem) return <p className="text-sm text-danger">{t(problem)}</p>;
  if (!state) return <p className="text-sm text-faint">{t("Cargando…")}</p>;
  const showForm = adding || state.accounts.length === 0;
  return (
    <div data-ui="mail-accounts" className="flex max-w-3xl flex-col gap-4">
      {notice ? <p className="text-sm text-accent">{t(notice)}</p> : null}
      {state.accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          state={state}
          open={(unfolded ?? new Set(state.accounts.length === 1 ? [account.id] : [])).has(
            account.id,
          )}
          onToggle={() =>
            setUnfolded((current) => {
              const next = new Set(current ?? (state.accounts.length === 1 ? [account.id] : []));
              if (next.has(account.id)) next.delete(account.id);
              else next.add(account.id);
              return next;
            })
          }
          onChanged={() => void load()}
        />
      ))}
      {showForm ? (
        <AddAccount
          state={state}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : state.accounts.length < state.limits.maxAccounts ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="h-10 rounded-md border border-dashed border-line text-sm text-muted hover:bg-elevated"
        >
          {t("Añadir otra cuenta")}
        </button>
      ) : null}
    </div>
  );
}

function AddAccount({ state, onDone }: { state: State; onDone: () => void }) {
  const [preset, setPreset] = useState("imap");
  const [form, setForm] = useState({
    name: "",
    email: "",
    username: "",
    host: "",
    port: 993,
    smtpHost: "",
    smtpPort: 587,
    password: "",
    historyDays: state.limits.maxHistoryDays,
    intervalSeconds: 300,
    attachmentPolicy: "demand" as "demand" | "small",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const oauth = async (provider: "gmail" | "microsoft") => {
    setBusy(true);
    const answer = await mailOAuthStart({
      data: { provider, accountId: null, hint: form.email.trim() },
    });
    if (answer.ok) window.location.assign(answer.url);
    else {
      setBusy(false);
      setError(answer.error);
    }
  };
  return (
    <form
      data-ui="mail-add"
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        void mailAddImap({ data: form })
          .then((answer) => {
            if (answer.ok) onDone();
            else setError(answer.error);
          })
          .catch(() => setError("No se pudo conectar."))
          .finally(() => setBusy(false));
      }}
    >
      <h3 className="text-sm font-semibold">{t("Conectar una cuenta")}</h3>
      {state.providers.gmail || state.providers.microsoft ? (
        <div className="flex flex-wrap gap-2">
          {state.providers.gmail ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void oauth("gmail")}
              className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated"
            >
              {t("Conectar Gmail")}
            </button>
          ) : null}
          {state.providers.microsoft ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void oauth("microsoft")}
              className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated"
            >
              {t("Conectar Microsoft 365 / Outlook")}
            </button>
          ) : null}
        </div>
      ) : null}
      {state.providers.imap ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              {t("Proveedor")}
              <select
                aria-label={t("Proveedor")}
                value={preset}
                onChange={(event) => {
                  const next =
                    PRESETS.find((item) => item.id === event.target.value) ?? PRESETS[0]!;
                  setPreset(next.id);
                  setForm({
                    ...form,
                    host: next.host,
                    port: next.port,
                    smtpHost: next.smtpHost,
                    smtpPort: next.smtpPort,
                  });
                }}
                className={input}
              >
                {PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Dirección de correo")}
              <input
                required
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Nombre de la cuenta")}
              <input
                value={form.name}
                placeholder={t("p. ej. «Trabajo»")}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Usuario (si no es la dirección)")}
              <input
                autoComplete="username"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Servidor IMAP")}
              <input
                required
                value={form.host}
                placeholder="imap.ejemplo.org"
                onChange={(event) => setForm({ ...form, host: event.target.value })}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Puerto y seguridad")}
              <select
                aria-label={t("Puerto y seguridad")}
                value={form.port}
                onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
                className={input}
              >
                <option value={993}>{t("993 · TLS")}</option>
                <option value={143}>{t("143 · STARTTLS")}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Servidor SMTP (envío)")}
              <input
                value={form.smtpHost}
                placeholder={form.host || "smtp.ejemplo.org"}
                onChange={(event) => setForm({ ...form, smtpHost: event.target.value })}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Puerto SMTP")}
              <select
                aria-label={t("Puerto SMTP")}
                value={form.smtpPort}
                onChange={(event) => setForm({ ...form, smtpPort: Number(event.target.value) })}
                className={input}
              >
                <option value={587}>{t("587 · STARTTLS")}</option>
                <option value={465}>{t("465 · TLS")}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Contraseña o contraseña de aplicación")}
              <input
                required
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Historial inicial")}
              <select
                aria-label={t("Historial inicial")}
                value={form.historyDays}
                onChange={(event) => setForm({ ...form, historyDays: Number(event.target.value) })}
                className={input}
              >
                {allowedHistory(state.limits.maxHistoryDays).map((days) => (
                  <option key={days} value={days}>
                    {historyLabel(days)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Frecuencia")}
              <select
                aria-label={t("Frecuencia")}
                value={form.intervalSeconds}
                onChange={(event) =>
                  setForm({ ...form, intervalSeconds: Number(event.target.value) })
                }
                className={input}
              >
                {INTERVALS.filter((seconds) => seconds >= state.limits.minInterval).map(
                  (seconds) => (
                    <option key={seconds} value={seconds}>
                      {t("Cada {0} min", { 0: seconds / 60 })}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Adjuntos")}
              <select
                aria-label={t("Adjuntos")}
                value={form.attachmentPolicy}
                onChange={(event) =>
                  setForm({ ...form, attachmentPolicy: event.target.value as "demand" | "small" })
                }
                className={input}
              >
                <option value="demand">{t("Al abrirlos")}</option>
                <option value="small">{t("Al abrirlos (y los pequeños al sincronizar)")}</option>
              </select>
            </label>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {t(error)}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="h-10 self-start rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {busy ? t("Comprobando la conexión…") : t("Conectar")}
          </button>
        </>
      ) : error ? (
        <p role="alert" className="text-sm text-danger">
          {t(error)}
        </p>
      ) : null}
    </form>
  );
}

function AccountCard({
  account,
  state,
  open,
  onToggle,
  onChanged,
}: {
  account: Account;
  state: State;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [password, setPassword] = useState("");
  const [smtp, setSmtp] = useState({ host: account.smtpHost, port: account.smtpPort });
  const [web, setWeb] = useState({ host: account.webHost, caldav: account.caldavUrl });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"disconnect" | "delete" | null>(null);
  const status = statusLabel(account);
  const folders = state.folders.filter((item) => item.accountId === account.id);
  const update = async (changes: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    const answer = await mailUpdateAccount({ data: { id: account.id, ...changes } }).catch(
      () => null,
    );
    setBusy(false);
    if (!answer?.ok) setError(answer?.error ?? "No se pudo guardar.");
    else onChanged();
  };
  const action = async (kind: "sync" | "disconnect" | "delete") => {
    setBusy(true);
    const answer = await mailAccountAction({ data: { id: account.id, action: kind } }).catch(
      () => null,
    );
    setBusy(false);
    setConfirm(null);
    if (!answer?.ok) setError(answer?.error ?? "No se pudo completar.");
    onChanged();
  };
  const reauthorize = async () => {
    if (account.provider === "imap") return;
    const answer = await mailOAuthStart({
      data: { provider: account.provider, accountId: account.id, hint: account.email },
    });
    if (answer.ok) window.location.assign(answer.url);
    else setError(answer.error);
  };
  return (
    <section
      data-ui="mail-account"
      data-account={account.id}
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {account.name}
            {account.isDefault ? (
              <span className="ml-2 text-xs font-normal text-faint">{t("Predeterminada")}</span>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted">
            {account.email} ·{" "}
            {account.provider === "imap"
              ? account.host
              : account.provider === "gmail"
                ? "Gmail"
                : "Microsoft"}
          </p>
          <p
            data-ui="mail-account-status"
            className={`text-xs ${status.tone === "danger" ? "text-danger" : "text-faint"}`}
          >
            {t(status.text, status.args)}
            {account.lastError && status.tone === "danger" ? ` · ${t(account.lastError)}` : ""}
          </p>
        </div>
        <TextAction
          onClick={() => void (!busy && account.status !== "disconnected" && action("sync"))}
        >
          {t("Sincronizar ahora")}
        </TextAction>
        <button
          type="button"
          data-ui="mail-account-fold"
          aria-expanded={open}
          aria-label={
            open ? t("Plegar {0}", { 0: account.email }) : t("Desplegar {0}", { 0: account.email })
          }
          onClick={onToggle}
          className="grid size-9 place-items-center rounded-md text-faint hover:bg-elevated hover:text-fg"
        >
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              {t("Nombre de la cuenta")}
              <input
                defaultValue={account.name}
                onBlur={(event) =>
                  event.target.value !== account.name && void update({ name: event.target.value })
                }
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Frecuencia")}
              <select
                aria-label={t("Frecuencia")}
                value={account.intervalSeconds}
                onChange={(event) => void update({ intervalSeconds: Number(event.target.value) })}
                className={input}
              >
                {INTERVALS.filter((seconds) => seconds >= state.limits.minInterval).map(
                  (seconds) => (
                    <option key={seconds} value={seconds}>
                      {t("Cada {0} min", { 0: seconds / 60 })}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Historial")}
              <select
                aria-label={t("Historial")}
                value={account.historyDays}
                onChange={(event) => void update({ historyDays: Number(event.target.value) })}
                className={input}
              >
                {allowedHistory(state.limits.maxHistoryDays).map((days) => (
                  <option key={days} value={days}>
                    {historyLabel(days)}
                  </option>
                ))}
              </select>
            </label>
            <Switch
              checked={account.syncEnabled}
              onChange={(value) => void update({ syncEnabled: value })}
              label={t("Sincronización automática")}
            />
            <Switch
              checked={account.isDefault}
              disabled={account.isDefault}
              onChange={() => void update({ isDefault: true })}
              label={t("Cuenta predeterminada")}
            />
            <Switch
              checked={account.mcpAccess}
              onChange={(value) => void update({ mcpAccess: value })}
              label={t("Permitir acceso por MCP")}
            />
          </div>
          {folders.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">
                {t("Carpetas que se sincronizan")}
              </summary>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {folders.map((folder) => (
                  <label key={folder.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      defaultChecked={folder.syncEnabled}
                      onChange={(event) =>
                        void mailFolderSync({
                          data: { id: folder.id, enabled: event.target.checked },
                        }).then(onChanged)
                      }
                    />
                    <span className="truncate">{folder.path}</span>
                    <span className="text-xs text-faint">{folder.total}</span>
                  </label>
                ))}
              </div>
            </details>
          ) : null}
          {account.provider === "imap" ? (
            <details data-ui="mail-web" className="text-sm">
              <summary className="cursor-pointer text-muted">{t("Directorio y agenda")}</summary>
              <form
                className="mt-2 grid gap-2 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void update({ webHost: web.host, caldavUrl: web.caldav });
                }}
              >
                <label className="flex flex-col gap-1">
                  {t("Servidor web")}
                  <input
                    value={web.host}
                    placeholder={account.host}
                    onChange={(event) => setWeb({ ...web, host: event.target.value })}
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {t("Dirección CalDAV")}
                  <input
                    value={web.caldav}
                    placeholder={`https://${web.host || account.host}/.well-known/caldav`}
                    onChange={(event) => setWeb({ ...web, caldav: event.target.value })}
                    className={input}
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    busy || (web.host === account.webHost && web.caldav === account.caldavUrl)
                  }
                  className="h-10 rounded-md border border-line px-3 hover:bg-elevated disabled:opacity-50 sm:col-span-2 sm:justify-self-end"
                >
                  {t("Guardar")}
                </button>
              </form>
            </details>
          ) : null}
          {account.provider === "imap" ? (
            <form
              data-ui="mail-smtp"
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void update({ smtpHost: smtp.host, smtpPort: smtp.port });
              }}
            >
              <input
                aria-label={t("Servidor SMTP (envío)")}
                placeholder={account.host}
                value={smtp.host}
                onChange={(event) => setSmtp({ ...smtp, host: event.target.value })}
                className={`${input} min-w-0 flex-1`}
              />
              <select
                aria-label={t("Puerto SMTP")}
                value={smtp.port}
                onChange={(event) => setSmtp({ ...smtp, port: Number(event.target.value) })}
                className={`${input} w-40`}
              >
                <option value={587}>{t("587 · STARTTLS")}</option>
                <option value={465}>{t("465 · TLS")}</option>
              </select>
              <button
                type="submit"
                disabled={
                  busy || (smtp.host === account.smtpHost && smtp.port === account.smtpPort)
                }
                className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated disabled:opacity-50"
              >
                {t("Guardar envío")}
              </button>
            </form>
          ) : null}
          {account.provider === "imap" ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void update({ password }).then(() => setPassword(""));
              }}
            >
              <input
                type="password"
                autoComplete="new-password"
                aria-label={t("Nueva contraseña de la cuenta")}
                placeholder={t("Nueva contraseña de la cuenta")}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={`${input} min-w-0 flex-1`}
              />
              <button
                type="submit"
                disabled={busy || !password}
                className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated disabled:opacity-50"
              >
                {t("Actualizar credenciales")}
              </button>
            </form>
          ) : (
            <TextAction onClick={() => void reauthorize()}>{t("Volver a autorizar")}</TextAction>
          )}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {t(error)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-2 text-sm">
            {confirm ? (
              <>
                <span className="text-muted">
                  {confirm === "disconnect"
                    ? t(
                        "¿Desconectar? Se olvidan las credenciales; los mensajes siguen aquí y nada cambia en el servidor.",
                      )
                    : t(
                        "¿Borrar la copia local de esta cuenta? Los documentos archivados se conservan y nada cambia en el servidor.",
                      )}
                </span>
                <TextAction tone="danger" onClick={() => void action(confirm)}>
                  {t("Sí")}
                </TextAction>
                <TextAction onClick={() => setConfirm(null)}>{t("No")}</TextAction>
              </>
            ) : (
              <>
                {account.status !== "disconnected" ? (
                  <TextAction onClick={() => setConfirm("disconnect")}>
                    {t("Desconectar")}
                  </TextAction>
                ) : null}
                <TextAction tone="danger" onClick={() => setConfirm("delete")}>
                  {t("Borrar la copia local")}
                </TextAction>
                {account.lastSyncAt ? (
                  <span className="ml-auto text-xs text-faint">
                    {t("Última sincronización: {0}", {
                      0: new Date(account.lastSyncAt).toLocaleString(intl()),
                    })}
                  </span>
                ) : null}
              </>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
