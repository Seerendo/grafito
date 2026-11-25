import {
  Archive,
  ArrowLeft,
  CalendarDays,
  File as FileIcon,
  FolderClosed,
  Inbox,
  Mail,
  Paperclip,
  PenSquare,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { intl, t } from "@/app/i18n";
import { AppFrame } from "@/components/chrome/AppFrame";
import { SearchField } from "@/components/ui/SearchField";
import { mailMessages, mailState } from "@/server/mailbox.functions";
import { Agenda } from "./Agenda";
import { Compose, type Draft } from "./Compose";
import { MessageView } from "./MessageView";
import { statusLabel } from "./status";

/**
 * Correo electrónico: accounts and folders on the left, a page-by-page list in the middle (only
 * the rows on screen are drawn), the message on the right. Syncing happens in the mail-sync
 * worker; this screen asks for the accounts' state every 15 s and refreshes the top of the list
 * when something arrived, without moving what the person is reading.
 */

type State = Extract<Awaited<ReturnType<typeof mailState>>, { ok: true }>;
type Row = Extract<Awaited<ReturnType<typeof mailMessages>>, { ok: true }>["messages"][number];

export type View =
  | {
      kind: "role";
      role: "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash";
      accountId?: string;
    }
  | { kind: "flagged"; accountId?: string }
  | { kind: "folder"; folderId: string; accountId: string };

const ROW = 76;

const ROLES: {
  role: "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash";
  label: string;
  icon: typeof Inbox;
}[] = [
  { role: "inbox", label: "Bandeja de entrada", icon: Inbox },
  { role: "sent", label: "Enviados", icon: Send },
  { role: "drafts", label: "Borradores", icon: FileIcon },
  { role: "archive", label: "Archivados", icon: Archive },
  { role: "junk", label: "Spam", icon: ShieldAlert },
  { role: "trash", label: "Papelera del correo", icon: Trash2 },
];

function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function MailScreen() {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState<"permission" | "off" | null>(null);
  const [view, setView] = useState<View>({ kind: "role", role: "inbox" });
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({
    unread: false,
    attachments: false,
    from: "",
    after: "",
    before: "",
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // On a phone one pane at a time: folders, the list, or the message.
  const [pane, setPane] = useState<"nav" | "list" | "message">("list");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [agenda, setAgenda] = useState(false);
  const [notice, setNotice] = useState("");
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);
  const stamp = useRef("");
  const request = useRef(0);

  const loadState = useCallback(async () => {
    const answer = await mailState().catch(() => null);
    if (!answer) return null;
    if (!answer.ok) {
      setProblem(answer.reason);
      return null;
    }
    setProblem(null);
    setState(answer);
    return answer;
  }, []);

  const filter = useMemo(() => {
    const base = {
      query: query.trim() || undefined,
      unread: filters.unread || undefined,
      attachments: filters.attachments || undefined,
      from: filters.from.trim() || undefined,
      after: filters.after ? new Date(`${filters.after}T00:00:00`).getTime() : undefined,
      before: filters.before
        ? new Date(`${filters.before}T00:00:00`).getTime() + 86_400_000
        : undefined,
    };
    if (view.kind === "folder")
      return { ...base, folderId: view.folderId, accountId: view.accountId };
    if (view.kind === "flagged") return { ...base, flagged: true, accountId: view.accountId };
    return { ...base, role: view.role, accountId: view.accountId };
  }, [view, query, filters]);

  const loadPage = useCallback(
    async (cursor: string | null) => {
      const ticket = ++request.current;
      setLoading(true);
      const answer = await mailMessages({ data: { ...filter, cursor } }).catch(() => null);
      if (ticket !== request.current) return;
      setLoading(false);
      if (!answer?.ok) return;
      setRows((current) =>
        cursor
          ? [
              ...current,
              ...answer.messages.filter((row) => !current.some((item) => item.id === row.id)),
            ]
          : answer.messages,
      );
      setNext(answer.next);
    },
    [filter],
  );

  // A new view or filter starts from the top.
  useEffect(() => {
    setRows([]);
    setNext(null);
    listRef.current?.scrollTo({ top: 0 });
    const timer = setTimeout(() => void loadPage(null), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadPage, query]);

  // Accounts' state every 15 s; new mail refreshes the top of the list.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const answer = await loadState();
      if (!alive || !answer) return;
      const now =
        answer.accounts.map((item) => `${item.id}:${item.lastSyncAt}:${item.status}`).join("|") +
        answer.folders.map((item) => `${item.id}:${item.total}`).join("|");
      if (stamp.current && stamp.current !== now) {
        const top = await mailMessages({ data: { ...filter, cursor: null } }).catch(() => null);
        if (alive && top?.ok)
          setRows((current) => {
            const known = new Map(current.map((row) => [row.id, row]));
            const fresh = top.messages.filter((row) => !known.has(row.id));
            const updated = current.map(
              (row) => top.messages.find((item) => item.id === row.id) ?? row,
            );
            return [...fresh, ...updated];
          });
      }
      stamp.current = now;
    };
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [loadState, filter]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [state]);

  // Near the end of what is loaded: the next page.
  useEffect(() => {
    if (next && !loading && (scroll + height) / ROW > rows.length - 10) void loadPage(next);
  }, [scroll, height, rows.length, next, loading, loadPage]);

  const accounts = useMemo(() => state?.accounts ?? [], [state]);
  const folders = useMemo(() => state?.folders ?? [], [state]);
  const multi = accounts.length > 1;
  const accountName = (id: string) => accounts.find((item) => item.id === id)?.name ?? "";

  if (problem === "permission")
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center text-sm text-muted">
          {t("Tu rol no incluye el correo electrónico.")}
        </p>
      </AppFrame>
    );
  if (problem === "off")
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">
          {t(
            "El correo electrónico no está activo. Un administrador lo enciende en Administración → Extensiones.",
          )}
        </p>
      </AppFrame>
    );
  if (!state)
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center text-sm text-faint">{t("Cargando…")}</p>
      </AppFrame>
    );
  // No account connected: nothing to show.
  if (accounts.length === 0)
    return (
      <AppFrame>
        <div data-ui="mail" data-empty className="flex-1" />
      </AppFrame>
    );

  const first = Math.max(0, Math.floor(scroll / ROW) - 5);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 5);

  const navItem = (
    key: string,
    active: boolean,
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
    count?: number,
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        onClick();
        setSelected(null);
        setPane("list");
        setAgenda(false);
      }}
      aria-current={active ? "page" : undefined}
      className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated"}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className="text-xs text-faint">{count}</span> : null}
    </button>
  );

  const unreadOf = (role: string, accountId?: string) =>
    folders
      .filter((item) => item.specialUse === role && (!accountId || item.accountId === accountId))
      .reduce((sum, item) => sum + item.unread, 0);

  return (
    <AppFrame>
      <div data-ui="mail" className="flex min-h-0 flex-1">
        <nav
          aria-label={t("Correo electrónico")}
          className={`${pane === "nav" ? "flex" : "hidden"} w-full shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-2 md:flex md:w-64`}
        >
          <div className="flex items-center gap-2 px-2 py-2">
            <Mail className="size-4 text-accent" />
            <h1 className="flex-1 text-sm font-semibold">{t("Correo electrónico")}</h1>
            <Link
              to="/cuenta"
              search={{ seccion: "buzones" }}
              aria-label={t("Cuentas de correo")}
              title={t("Cuentas de correo")}
              className="grid size-9 place-items-center rounded-md text-muted hover:bg-elevated"
            >
              <Settings className="size-4" />
            </Link>
          </div>
          <button
            type="button"
            onClick={() =>
              setDraft({
                accountId:
                  view.accountId ??
                  accounts.find((item) => item.isDefault)?.id ??
                  accounts[0]?.id ??
                  "",
                to: "",
                cc: "",
                subject: "",
                text: "",
                replyTo: null,
              })
            }
            className="mx-1 mb-2 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent text-sm font-medium text-accent-fg"
          >
            <PenSquare className="size-4" />
            {t("Redactar")}
          </button>
          {notice ? <p className="px-2 pb-2 text-xs text-accent">{t(notice)}</p> : null}
          <button
            type="button"
            data-ui="mail-agenda-entry"
            aria-current={agenda ? "page" : undefined}
            onClick={() => {
              setAgenda(true);
              setSelected(null);
              setPane("list");
            }}
            className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${agenda ? "bg-elevated text-fg" : "text-muted hover:bg-elevated"}`}
          >
            <CalendarDays className="size-4" />
            <span className="min-w-0 flex-1 truncate">{t("Agenda")}</span>
          </button>
          {navItem(
            "unified",
            sameView(view, { kind: "role", role: "inbox" }),
            () => setView({ kind: "role", role: "inbox" }),
            <Inbox className="size-4" />,
            multi ? t("Bandeja unificada") : t("Bandeja de entrada"),
            unreadOf("inbox"),
          )}
          {navItem(
            "flagged",
            sameView(view, { kind: "flagged" }),
            () => setView({ kind: "flagged" }),
            <Star className="size-4" />,
            t("Destacados"),
          )}
          {ROLES.slice(1).map((item) =>
            navItem(
              item.role,
              sameView(view, { kind: "role", role: item.role }),
              () => setView({ kind: "role", role: item.role }),
              <item.icon className="size-4" />,
              t(item.label),
            ),
          )}
          {accounts.map((account) => {
            const status = statusLabel(account);
            const custom = folders.filter(
              (item) => item.accountId === account.id && !item.specialUse,
            );
            return (
              <section key={account.id} className="mt-3 border-t border-line pt-2">
                <p className="truncate px-2 text-xs font-medium text-faint" title={account.email}>
                  {account.name}
                </p>
                <p
                  data-ui="mail-status"
                  className={`truncate px-2 pb-1 text-xs ${status.tone === "danger" ? "text-danger" : "text-faint"}`}
                >
                  {t(status.text, status.args)}
                </p>
                {multi
                  ? navItem(
                      `in-${account.id}`,
                      sameView(view, { kind: "role", role: "inbox", accountId: account.id }),
                      () => setView({ kind: "role", role: "inbox", accountId: account.id }),
                      <Inbox className="size-4" />,
                      t("Bandeja de entrada"),
                      unreadOf("inbox", account.id),
                    )
                  : null}
                {custom.map((folder) =>
                  navItem(
                    folder.id,
                    sameView(view, { kind: "folder", folderId: folder.id, accountId: account.id }),
                    () => setView({ kind: "folder", folderId: folder.id, accountId: account.id }),
                    <FolderClosed className="size-4" />,
                    folder.path,
                    folder.unread,
                  ),
                )}
              </section>
            );
          })}
        </nav>
        {agenda ? (
          <Agenda
            accounts={accounts}
            className={`${pane === "list" ? "flex" : "hidden"} min-w-0 flex-1 md:flex`}
            onBack={() => setPane("nav")}
          />
        ) : null}
        <section
          className={`${agenda ? "hidden" : `${pane === "list" ? "flex" : "hidden"} ${selected ? "md:hidden lg:flex" : "md:flex"}`} min-w-0 flex-1 flex-col border-r border-line lg:max-w-md`}
        >
          <div className="flex flex-col gap-2 border-b border-line p-2">
            <button
              type="button"
              onClick={() => setPane("nav")}
              className="flex h-9 items-center gap-2 text-sm text-accent md:hidden"
            >
              <ArrowLeft className="size-4" />
              {t("Carpetas")}
            </button>
            <div className="flex gap-2">
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={t("Buscar en el correo")}
              />
              <button
                type="button"
                aria-label={t("Actualizar")}
                onClick={() => void loadPage(null)}
                className="grid size-10 shrink-0 place-items-center rounded-md border border-line text-muted hover:bg-elevated"
              >
                <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
            <details className="text-xs text-muted">
              <summary className="cursor-pointer select-none">{t("Filtros")}</summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={filters.unread}
                    onChange={(event) => setFilters({ ...filters, unread: event.target.checked })}
                  />
                  {t("Sin leer")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={filters.attachments}
                    onChange={(event) =>
                      setFilters({ ...filters, attachments: event.target.checked })
                    }
                  />
                  {t("Con adjuntos")}
                </label>
                <input
                  aria-label={t("Remitente")}
                  placeholder={t("Remitente")}
                  value={filters.from}
                  onChange={(event) => setFilters({ ...filters, from: event.target.value })}
                  className="col-span-2 h-9 rounded-md border border-line bg-inset px-2"
                />
                <label className="flex flex-col gap-1">
                  {t("Desde")}
                  <input
                    type="date"
                    value={filters.after}
                    onChange={(event) => setFilters({ ...filters, after: event.target.value })}
                    className="h-9 rounded-md border border-line bg-inset px-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {t("Hasta")}
                  <input
                    type="date"
                    value={filters.before}
                    onChange={(event) => setFilters({ ...filters, before: event.target.value })}
                    className="h-9 rounded-md border border-line bg-inset px-2"
                  />
                </label>
                {multi ? (
                  <select
                    aria-label={t("Cuenta")}
                    value={"accountId" in view ? (view.accountId ?? "") : ""}
                    onChange={(event) => {
                      const accountId = event.target.value || undefined;
                      setView(
                        view.kind === "folder"
                          ? { kind: "role", role: "inbox", accountId }
                          : ({ ...view, accountId } as View),
                      );
                    }}
                    className="col-span-2 h-9 rounded-md border border-line bg-inset px-2"
                  >
                    <option value="">{t("Todas las cuentas")}</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </details>
          </div>
          <div
            ref={listRef}
            data-ui="mail-list"
            onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
            className="relative min-h-0 flex-1 overflow-y-auto"
          >
            {rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-faint">
                {loading
                  ? t("Cargando…")
                  : accounts.some((item) => item.phase === "initial")
                    ? t("Los mensajes aparecen a medida que se sincronizan.")
                    : t("No hay mensajes.")}
              </p>
            ) : (
              <div style={{ height: rows.length * ROW }} role="list">
                {rows.slice(first, last).map((row, index) => (
                  <button
                    key={row.id}
                    type="button"
                    role="listitem"
                    data-message={row.id}
                    onClick={() => {
                      setSelected(row.id);
                      setPane("message");
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, seen: true } : item,
                        ),
                      );
                    }}
                    style={{
                      position: "absolute",
                      top: (first + index) * ROW,
                      height: ROW,
                      left: 0,
                      right: 0,
                    }}
                    className={`flex flex-col gap-0.5 border-b border-line px-3 py-2 text-left ${selected === row.id ? "bg-elevated" : "hover:bg-elevated"}`}
                  >
                    <span className="flex items-center gap-2 text-sm">
                      {!row.seen ? (
                        <span
                          aria-label={t("Sin leer")}
                          className="size-2 shrink-0 rounded-full bg-accent"
                        />
                      ) : null}
                      <span
                        className={`min-w-0 flex-1 truncate ${row.seen ? "text-muted" : "font-semibold"}`}
                      >
                        {row.from.name || row.from.address || t("(sin remitente)")}
                      </span>
                      {row.flagged ? (
                        <Star
                          aria-label={t("Destacado")}
                          className="size-3.5 shrink-0 fill-current text-accent"
                        />
                      ) : null}
                      {row.hasAttachments ? (
                        <Paperclip
                          aria-label={t("Con adjuntos")}
                          className="size-3.5 shrink-0 text-faint"
                        />
                      ) : null}
                      <time className="shrink-0 text-xs text-faint">
                        {new Date(row.receivedAt).toLocaleString(intl(), {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </time>
                    </span>
                    <span className={`truncate text-sm ${row.seen ? "text-muted" : "text-fg"}`}>
                      {row.subject || t("(sin asunto)")}
                    </span>
                    <span className="truncate text-xs text-faint">
                      {multi ? `${accountName(row.accountId)} · ` : ""}
                      {row.snippet}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
        <section
          className={`${pane === "message" && !agenda ? "flex" : "hidden"} ${agenda ? "md:hidden" : selected ? "md:flex" : "md:hidden lg:flex"} min-w-0 flex-[1.4] flex-col`}
        >
          {selected ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setPane("list");
                }}
                className="flex h-10 items-center gap-2 px-3 text-sm text-accent lg:hidden"
              >
                <ArrowLeft className="size-4" />
                {t("Volver a la lista")}
              </button>
              <MessageView
                key={selected}
                id={selected}
                onCompose={setDraft}
                onChanged={(change) =>
                  setRows((current) =>
                    current
                      .map((row) => (row.id === selected ? { ...row, ...change } : row))
                      .filter((row) => !("hidden" in change) || row.id !== selected),
                  )
                }
              />
            </>
          ) : (
            <p className="grid flex-1 place-items-center text-sm text-faint">
              {t("Elige un mensaje.")}
            </p>
          )}
        </section>
      </div>
      {draft ? (
        <Compose
          draft={draft}
          accounts={accounts}
          onClose={() => setDraft(null)}
          onSent={(sentCopy) => {
            setDraft(null);
            setNotice(
              sentCopy
                ? "Mensaje enviado."
                : "Mensaje enviado; no se pudo guardar la copia en Enviados.",
            );
            void loadState();
          }}
        />
      ) : null}
    </AppFrame>
  );
}
