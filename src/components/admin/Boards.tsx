import { copyText } from "@/lib/clipboard";
import { useEffect, useMemo, useState } from "react";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { TextAction } from "@/components/ui/TextAction";
import { UsageMeter } from "@/components/ui/UsageMeter";
import type { adminState, systemLogs, systemSnapshot } from "@/server/admin.functions";
import {
  createRole,
  createVaultUser,
  deleteRole,
  deleteVaultUser,
  resendVaultAccess,
  renameRole,
  setRolePermission,
  systemLogs as loadLogs,
  systemSnapshot as loadSnapshot,
  updateVaultUser,
} from "@/server/admin.functions";
import { intl, t } from "@/app/i18n";

export type AdminView = Extract<Awaited<ReturnType<typeof adminState>>, { isAdmin: true }>;

function can(view: AdminView, key: string) {
  return view.owner || view.actorPermissions.includes(key);
}

export function UsersBoard({ view, reload }: { view: AdminView; reload: () => void }) {
  const [open, setOpen] = useState<"new" | { id: string } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  // Lo que pasó con el último acceso enviado (correo o enlace para entregar a mano).
  const [sent, setSent] = useState<{ name: string; access: AccessOutcome } | null>(null);
  const people = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return view.users;
    return view.users.filter((person) =>
      [person.name, person.loginName].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [query, view.users]);
  if (!can(view, "users.create") && !can(view, "users.update") && !can(view, "users.delete")) {
    return <p className="text-sm text-muted">{t("Este rol no administra usuarios.")}</p>;
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder={t("Buscar usuario")} />
        {can(view, "users.create") ? (
          <button type="button" onClick={() => { setError(""); setOpen("new"); }} className="h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
            {t("Nuevo usuario")}
          </button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      {sent ? <AccessNotice name={sent.name} access={sent.access} onClose={() => setSent(null)} /> : null}
      {people.length === 0 ? <p className="text-sm text-muted">{t("Ningún usuario coincide.")}</p> : null}
      <ul className="overflow-hidden rounded-lg border border-line bg-surface empty:hidden">
        {people.map((person) => (
          <li key={person.id} className="flex items-center gap-2 border-b border-line last:border-b-0">
            {can(view, "users.update") ? (
              <button
                type="button"
                onClick={() => { setError(""); setOpen({ id: person.id }); }}
                className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 text-left text-sm hover:bg-elevated"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{person.name}</span>
                  <SourceTag source={person.source} />
                </span>
                <SignIns first={person.firstLoginAt} last={person.lastSeenAt} />
                <AccessState access={person.access} />
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{person.name}</span>
                  <SourceTag source={person.source} />
                </span>
                <SignIns first={person.firstLoginAt} last={person.lastSeenAt} />
                <AccessState access={person.access} />
              </div>
            )}
            {can(view, "users.delete") && !person.owner ? (
              confirming === person.id ? (
                <span className="mr-4 flex shrink-0 items-center gap-3 text-sm">
                  <span className="text-muted">{t("¿Eliminar?")}</span>
                  <TextAction
                    tone="danger"
                    onClick={() => {
                      setError("");
                      setConfirming(null);
                      void deleteVaultUser({ data: { userId: person.id } }).then((result) => {
                        if (!result.ok) setError(result.error);
                        else reload();
                      });
                    }}
                  >
                    {t("Sí")}
                  </TextAction>
                  <TextAction onClick={() => setConfirming(null)}>{t("No")}</TextAction>
                </span>
              ) : (
                <TextAction tone="danger" className="mr-4" onClick={() => setConfirming(person.id)}>
                  {t("Eliminar")}
                </TextAction>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {open === "new" ? (
        <UserForm
          roles={view.roles}
          title={t("Nuevo usuario")}
          onClose={() => setOpen(null)}
          onSubmit={async (values) => {
            const result = await createVaultUser({
              data: { name: values.name, username: values.username, email: values.email, roleId: values.roleId },
            });
            if (!result.ok) return result.error;
            setOpen(null);
            setSent({ name: values.name, access: result.access });
            reload();
            return "";
          }}
        />
      ) : null}
      {open && open !== "new" ? (
        <UserForm
          roles={view.roles}
          title={t("Actualizar usuario")}
          person={view.users.find((item) => item.id === open.id)}
          onClose={() => setOpen(null)}
          onSubmit={async (values) => {
            const result = await updateVaultUser({
              data: {
                userId: open.id,
                name: values.name,
                roleId: values.roleId,
                email: values.email,
              },
            });
            if (!result.ok) return result.error;
            setOpen(null);
            reload();
            return "";
          }}
          onResend={async () => {
            const person = view.users.find((item) => item.id === open.id);
            const result = await resendVaultAccess({ data: { userId: open.id } });
            if (!result.ok) return result.error;
            setOpen(null);
            setSent({ name: person?.name ?? "", access: result.access });
            reload();
            return "";
          }}
        />
      ) : null}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  ldap: "LDAP",
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  sso: "SSO",
};

/** Origen de una cuenta creada al entrar por un proveedor externo. */
type AccessOutcome = { mailed: true; expiresAt: number } | { mailed: false; link: string; expiresAt: number; reason: string };

function formatWhen(ms: number) {
  return new Intl.DateTimeFormat(intl(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

/** Estado del acceso temporal por correo de un usuario. */
function AccessState({ access }: { access: AdminView["users"][number]["access"] }) {
  if (!access) return null;
  const text =
    access.state === "pending"
      ? t("Acceso enviado: vence {0}", { 0: formatWhen(access.expiresAt) })
      : access.state === "used"
        ? t("Entró con la contraseña temporal; aún no la cambió")
        : t("El acceso venció: reenvíalo");
  return <span className={`text-xs ${access.state === "expired" ? "text-danger" : "text-accent"}`}>{text}</span>;
}

/**
 * Tras crear un usuario o reenviarle el acceso: si el correo salió, o el enlace
 * de un solo uso para entregárselo a mano (se muestra solo esta vez).
 */
function AccessNotice({ name, access, onClose }: { name: string; access: AccessOutcome; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface p-4 text-sm">
      {access.mailed ? (
        <p>{t("Se envió el acceso a {0}. Vence {1}.", { 0: name, 1: formatWhen(access.expiresAt) })}</p>
      ) : (
        <>
          <p className="text-danger">{t("No se envió el correo: {0}", { 0: t(access.reason) })}</p>
          <p className="text-muted">
            {t("Entrega este enlace a {0} por otro medio. Se abre una sola vez y vence {1}.", {
              0: name,
              1: formatWhen(access.expiresAt),
            })}
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={access.link}
              onFocus={(event) => event.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                void copyText(access.link).then(() => setCopied(true));
              }}
              className="h-10 shrink-0 rounded-md border border-line px-3 text-sm hover:bg-elevated"
            >
              {copied ? t("Copiado") : t("Copiar")}
            </button>
          </div>
        </>
      )}
      <TextAction onClick={onClose}>{t("Cerrar")}</TextAction>
    </div>
  );
}

/** Primer ingreso y última conexión, con fecha y hora. */
function SignIns({ first, last }: { first: number | null; last: number | null }) {
  const when = (ms: number) =>
    new Intl.DateTimeFormat(intl(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  if (!first && !last) return <span className="text-xs text-faint">{t("Todavía no ha ingresado")}</span>;
  return (
    <span className="flex flex-wrap gap-x-4 text-xs text-faint">
      {first ? <span>{t("Primer ingreso: {0}", { 0: when(first) })}</span> : null}
      {last ? <span>{t("Última conexión: {0}", { 0: when(last) })}</span> : null}
    </span>
  );
}

function SourceTag({ source }: { source: string }) {
  const label = SOURCE_LABEL[source];
  if (!label) return null;
  return <span className="shrink-0 rounded border border-line px-1.5 text-[11px] leading-5 text-faint">{label}</span>;
}

function UserForm({
  roles,
  title,
  person,
  onClose,
  onSubmit,
  onResend,
}: {
  roles: AdminView["roles"];
  title: string;
  person?: AdminView["users"][number];
  onClose: () => void;
  onSubmit: (values: { name: string; username: string; email: string; roleId: string }) => Promise<string>;
  /** Reenviar el acceso por correo (solo al editar una cuenta local). */
  onResend?: () => Promise<string>;
}) {
  const [name, setName] = useState(person?.name ?? "");
  const [username, setUsername] = useState(person?.loginName ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [roleId, setRoleId] = useState(person?.owner ? "admin" : person?.roleId || roles.find((role) => role.id === "miembro")?.id || roles[0]?.id || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3 rounded-lg border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        void onSubmit({ name, username, email, roleId }).then((message) => {
          setBusy(false);
          if (message) setError(message);
        });
      }}
    >
      <h2 className="font-serif text-2xl">{title}</h2>
      <label className="block text-sm">
        <span className="text-muted">{t("Nombre")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} required className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3" />
      </label>
      <label className="block text-sm">
        <span className="text-muted">{t("Usuario")}</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
          disabled={Boolean(person)}
          autoComplete="off"
          className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3 disabled:opacity-60"
        />
      </label>
      <label className="block text-sm">
        <span className="text-muted">{t("Correo")}</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required={!person}
          // Con LDAP, OAuth o SSO el correo lo da el proveedor.
          readOnly={Boolean(person && person.source !== "local")}
          autoComplete="off"
          className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3 read-only:text-muted"
        />
      </label>
      <label className="block text-sm">
        <span className="text-muted">{t("Rol")}</span>
        {person?.owner ? (
          <p className="mt-1 flex h-11 items-center rounded-md border border-line bg-inset px-3 text-muted" title={t("El administrador inicial siempre es Administrador")}>
            {t("Administrador")}
          </p>
        ) : (
          <Select value={roleId} onChange={setRoleId} className="mt-1">
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {t(role.name)}
              </option>
            ))}
          </Select>
        )}
      </label>
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50">
          {busy ? t("Guardando…") : t("Guardar")}
        </button>
        {onResend && person && !person.owner && person.source === "local" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void onResend().then((message) => {
                setBusy(false);
                if (message) setError(message);
              });
            }}
            className="h-11 rounded-md border border-line px-4 text-sm text-fg hover:bg-elevated disabled:opacity-50"
          >
            {t("Reenviar acceso")}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className="h-11 rounded-md px-4 text-sm text-muted hover:bg-elevated">
          {t("Cancelar")}
        </button>
      </div>
    </form>
  );
}

export function RolesBoard({
  view,
  reload,
  roleId,
  onOpen,
}: {
  view: AdminView;
  reload: () => void;
  roleId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const role = view.roles.find((item) => item.id === roleId) ?? null;
  if (!can(view, "roles.manage")) return <p className="text-sm text-muted">{t("Este rol no administra permisos.")}</p>;
  if (role) {
    return <RoleGrid role={role} permissions={view.permissions} onBack={() => onOpen(null)} reload={reload} />;
  }
  return (
    <div className="space-y-4">
      {creating ? (
        <form
          className="flex flex-wrap gap-2 rounded-lg border border-line bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            void createRole({ data: { name } }).then((result) => {
              if (!result.ok) setError(result.error);
              else {
                setName("");
                setCreating(false);
                reload();
              }
            });
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={t("Nombre del rol")}
            placeholder={t("Nombre del rol")}
            autoFocus
            required
            className="h-11 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-sm"
          />
          <button type="submit" className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
            {t("Crear")}
          </button>
          <button
            type="button"
            onClick={() => {
              setName("");
              setCreating(false);
            }}
            className="h-11 rounded-md px-4 text-sm text-muted hover:bg-elevated"
          >
            {t("Cancelar")}
          </button>
        </form>
      ) : (
        <div className="flex">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ml-auto h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
          >
            {t("Nuevo rol")}
          </button>
        </div>
      )}
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      <ul className="overflow-hidden rounded-lg border border-line bg-surface">
        {view.roles.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 last:border-b-0">
            <button type="button" onClick={() => onOpen(item.id)} className="min-w-0 flex-1 text-left">
              <span className="block text-sm">{t(item.name)}</span>
              <span className="block text-xs text-muted">{item.fixed ? t("Predeterminado") : t("Creado aquí")} · {item.permissions.length}{" "}{t("permisos")}</span>
            </button>
            {item.fixed ? null : renaming === item.id ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const next = draft.trim();
                  if (!next || next === item.name) {
                    setRenaming(null);
                    return;
                  }
                  setError("");
                  void renameRole({ data: { id: item.id, name: next } }).then((result) => {
                    if (!result.ok) setError(result.error);
                    else {
                      setRenaming(null);
                      reload();
                    }
                  });
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className="h-11 w-36 rounded-md border border-line bg-inset px-2 text-sm"
                />
                <button type="submit" className="h-11 rounded-md px-3 text-sm text-accent">
                  {t("Guardar")}
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(item.name);
                    setRenaming(item.id);
                  }}
                  className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg"
                >
                  {t("Renombrar")}
                </button>
                <TextAction
                  tone="danger"
                  className="px-3"
                  onClick={() => {
                    setError("");
                    void deleteRole({ data: { id: item.id } }).then((result) => {
                      if (!result.ok) setError(result.error);
                      else reload();
                    });
                  }}
                >
                  {t("Eliminar")}
                </TextAction>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleGrid({
  role,
  permissions,
  onBack,
  reload,
}: {
  role: AdminView["roles"][number];
  permissions: AdminView["permissions"];
  onBack: () => void;
  reload: () => void;
}) {
  const areas = useMemo(() => {
    const order: string[] = [];
    const groups = new Map<string, AdminView["permissions"]>();
    for (const permission of permissions) {
      const list = groups.get(permission.area) ?? [];
      if (list.length === 0) order.push(permission.area);
      list.push(permission);
      groups.set(permission.area, list);
    }
    return order.map((area) => ({ area, items: groups.get(area) ?? [] }));
  }, [permissions]);
  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 text-sm text-accent">
        {t("Roles")}
      </button>
      <div className="space-y-5">
        {areas.map((group) => (
          <section key={group.area}>
            <h3 className="text-xs font-medium tracking-widest text-faint uppercase">{t(group.area)}</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {group.items.map((permission) => {
                const on = role.locked || role.permissions.includes(permission.key);
                return (
                  <button
                    key={permission.key}
                    type="button"
                    aria-pressed={on}
                    disabled={role.locked}
                    onClick={() => {
                      void setRolePermission({ data: { roleId: role.id, key: permission.key, granted: !on } }).then(reload);
                    }}
                    className={`flex min-h-16 items-start gap-3 rounded-md border px-3 py-3 text-left disabled:opacity-80 ${
                      on ? "border-accent bg-surface" : "border-line bg-inset"
                    }`}
                  >
                    <span
                      className={`grid size-4 shrink-0 place-items-center self-start border ${
                        on ? "border-accent bg-accent text-accent-fg" : "border-line"
                      }`}
                    >
                      {on ? (
                        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="block">
                          <path
                            d="M2.2 6.1 4.7 8.6 9.8 3.4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                    <span className="text-sm">{t(permission.label)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function MonitorBoard() {
  const [snap, setSnap] = useState<Extract<Awaited<ReturnType<typeof systemSnapshot>>, { ok: true }> | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    void loadSnapshot()
      .then((result) => {
        if (!result.ok) setError(t("Sin permiso."));
        else setSnap(result);
      })
      .catch(() => setError(t("No se pudo leer el sistema.")));
  };
  useEffect(() => {
    load();
  }, []);
  if (error) return <p className="text-sm text-danger">{t(error)}</p>;
  if (!snap) return <p className="text-sm text-muted">{t("Leyendo…")}</p>;
  const mem = snap.memTotal > 0 ? Math.round(((snap.memTotal - snap.memFree) / snap.memTotal) * 100) : 0;
  const meters = [
    ["CPU", `${snap.cpu}%`, snap.cpu],
    [t("Memoria"), `${mem}%`, mem],
  ] as const;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted">{snap.hostname} · {snap.cores}{" "}{t("núcleos")}</p>
        <button type="button" onClick={load} className="ml-auto h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated">
          {t("Actualizar")}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {meters.map(([label, value, percent]) => (
          <div key={label} className="border border-line bg-surface p-4">
            <p className="text-xs tracking-widest text-faint uppercase">{label}</p>
            <p className="mt-1 font-serif text-3xl">{value}</p>
            <UsageMeter percent={percent} label={label} />
          </div>
        ))}
        <div className="border border-line bg-surface p-4">
          <p className="text-xs tracking-widest text-faint uppercase">{t("Carga")}</p>
          <p className="mt-1 font-serif text-3xl">{snap.load[0] ?? 0}</p>
          <p className="mt-2 text-xs text-muted">{t("1, 5 y 15 min:")}{" "}{snap.load.join(" · ")}</p>
        </div>
        <div className="border border-line bg-surface p-4">
          <p className="text-xs tracking-widest text-faint uppercase">{t("En marcha")}</p>
          <p className="mt-1 font-serif text-3xl">{formatUptime(snap.uptime)}</p>
          <p className="mt-2 text-xs text-muted">{t("Proceso")}{" "}{formatBytes(snap.rss)}</p>
        </div>
      </div>
    </div>
  );
}

export function LogsBoard() {
  const [rows, setRows] = useState<Extract<Awaited<ReturnType<typeof systemLogs>>, { ok: true }>["rows"]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void loadLogs()
      .then((result) => {
        if (!result.ok) setError(t("Sin permiso."));
        else setRows(result.rows);
      })
      .catch(() => setError(t("No se pudieron leer los registros.")));
  }, []);
  if (error) return <p className="text-sm text-danger">{t(error)}</p>;
  if (rows.length === 0) return <p className="text-sm text-muted">{t("Todavía no hay registros.")}</p>;
  return (
    <ul className="overflow-hidden rounded-lg border border-line bg-surface">
      {rows.map((row) => (
        <li key={row.id} className="border-b border-line px-4 py-3 last:border-b-0">
          <p className="text-sm">{t(row.message)}</p>
          <p className="mt-1 text-xs text-muted">
            {t(row.area)} · {row.actor || t("sistema")} · {row.at.replace("T", " ").slice(0, 19)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
