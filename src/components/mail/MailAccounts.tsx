import { useState } from "react";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { TextAction } from "@/components/ui/TextAction";
import {
  mailAccountAction,
  mailAddImap,
  mailFolderSync,
  mailOAuthStart,
  mailState,
  mailUpdateAccount,
} from "@/server/mailbox.functions";
import { statusLabel } from "./status";

/**
 * Cuentas de correo: connect (IMAP with a password, or Gmail and Microsoft through their own
 * sign-in), and for each account its state, sync settings, folders, the MCP permission, new
 * credentials, disconnecting and deleting the local copy. Passwords are sent once and never shown
 * again.
 */

type State = Extract<Awaited<ReturnType<typeof mailState>>, { ok: true }>;
type Account = State["accounts"][number];

const INTERVALS = [120, 300, 600, 1800, 3600, 21_600];
const HISTORY = [7, 30, 90, 180, 365, 730, 3650];

const input = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

export function MailAccounts({
  state,
  onClose,
  onChanged,
}: {
  state: State;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(state.accounts.length === 0);
  return (
    <Modal title={t("Cuentas de correo")} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {state.accounts.map((account) => (
          <AccountCard key={account.id} account={account} state={state} onChanged={onChanged} />
        ))}
        {adding ? (
          <AddAccount
            state={state}
            onDone={() => {
              setAdding(false);
              onChanged();
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
    </Modal>
  );
}

function AddAccount({ state, onDone }: { state: State; onDone: () => void }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    username: "",
    host: "",
    port: 993,
    password: "",
    profileId: state.profiles[0]?.id ?? "",
    historyDays: Math.min(30, state.limits.maxHistoryDays),
    intervalSeconds: 300,
    attachmentPolicy: "demand" as "demand" | "small",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const custom = !form.profileId;
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
  // The domain of the address suggests an institutional profile.
  const suggest = (email: string) => {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const match = state.profiles.find((profile) =>
      profile.domains.some((item) => domain === item || domain.endsWith(`.${item}`)),
    );
    return match?.id;
  };
  return (
    <form
      data-ui="mail-add"
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        void mailAddImap({ data: { ...form, profileId: form.profileId || null } })
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
            <label className="flex flex-col gap-1 text-sm">
              {t("Dirección de correo")}
              <input
                required
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(event) => {
                  const email = event.target.value;
                  const profileId = suggest(email);
                  setForm({ ...form, email, ...(profileId ? { profileId } : {}) });
                }}
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
              {t("Servidor")}
              <select
                aria-label={t("Servidor")}
                value={form.profileId}
                onChange={(event) => setForm({ ...form, profileId: event.target.value })}
                className={input}
              >
                {state.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
                {!state.limits.profilesOnly ? (
                  <option value="">{t("Otro servidor IMAP")}</option>
                ) : null}
              </select>
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
            {custom ? (
              <>
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
              </>
            ) : null}
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
                {HISTORY.filter((days) => days <= state.limits.maxHistoryDays).map((days) => (
                  <option key={days} value={days}>
                    {t("Últimos {0} días", { 0: days })}
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
  onChanged,
}: {
  account: Account;
  state: State;
  onChanged: () => void;
}) {
  const [password, setPassword] = useState("");
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
      </div>
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
            {INTERVALS.filter((seconds) => seconds >= state.limits.minInterval).map((seconds) => (
              <option key={seconds} value={seconds}>
                {t("Cada {0} min", { 0: seconds / 60 })}
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
              <TextAction onClick={() => setConfirm("disconnect")}>{t("Desconectar")}</TextAction>
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
    </section>
  );
}
