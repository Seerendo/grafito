import { uuid } from "@/lib/uuid";
import {
  Archive,
  ArrowLeft,
  X,
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
  Flag,
  CalendarPlus,
  Eye,
  EyeOff,
  Forward,
  MailOpen,
  Reply,
  SquarePlus,
  ReplyAll,
  Archive as ArchiveIcon,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import type { MailSearch } from "@/routes/mail";
import { intl, t } from "@/app/i18n";
import { AppFrame } from "@/components/chrome/AppFrame";
import { SearchField } from "@/components/ui/SearchField";
import {
  mailDelete,
  mailMark,
  mailMessages,
  mailRefresh,
  mailState,
} from "@/server/mailbox.functions";
import { toast } from "@/app/toast";
import { Toaster } from "@/components/ui/Toaster";
import { Agenda, ScheduleMeeting } from "./Agenda";
import { MailPreferences } from "./MailPreferences";
import { Compose, type Draft } from "./Compose";
import { MessageView, type Intent, type MeetingPrefill } from "./MessageView";
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

type Tab =
  | { id: string; kind: "message"; messageId: string }
  | { id: string; kind: "compose"; draft: Draft; title: string; closing: boolean };

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

const ROLES_IN_URL = ["inbox", "sent", "drafts", "archive", "junk", "trash"] as const;

/** The mailbox shown, from the address (/mail?box=sent, ?folder=…&account=…). */
function viewOf(search: MailSearch): View {
  const accountId = search.account || undefined;
  if (search.folder && accountId) return { kind: "folder", folderId: search.folder, accountId };
  if (search.box === "flagged") return { kind: "flagged", accountId };
  const role = ROLES_IN_URL.find((item) => item === search.box) ?? "inbox";
  return { kind: "role", role, accountId };
}

function searchOf(view: View): MailSearch {
  if (view.kind === "folder") return { folder: view.folderId, account: view.accountId };
  if (view.kind === "flagged") return { box: "flagged", account: view.accountId };
  return { box: view.role === "inbox" ? undefined : view.role, account: view.accountId };
}

function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function MailScreen() {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState<"permission" | "off" | null>(null);
  // Where the person is lives in the address: /mail (a mailbox) or /mail/calendar (the Agenda),
  // so a reload or a link opens the same place.
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ strict: false }) as MailSearch;
  const agenda = location.pathname.replace(/\/+$/, "") === "/mail/calendar";
  const view = useMemo(
    () => viewOf(search),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search.box, search.folder, search.account],
  );
  const setView = (next: View) => void navigate({ to: "/mail", search: searchOf(next) });
  const setAgenda = (on: boolean) =>
    void navigate(
      on
        ? { to: "/mail/calendar", search: { view: search.view, date: search.date } }
        : { to: "/mail", search: searchOf(view) },
    );
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
  // Messages ticked for an action on several at once (Ctrl or Shift and a click, or the box).
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // On a phone one pane at a time: folders, the list, or the message.
  const [pane, setPane] = useState<"nav" | "list" | "message">("list");
  // Tabs of the reading pane, like Outlook: «read» shows the message chosen in the list; others
  // hold a message opened in its own tab or a message being written.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("read");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [meeting, setMeeting] = useState<MeetingPrefill | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [settings, setSettings] = useState<"menu" | "preferences" | null>(null);
  const [settingsAt, setSettingsAt] = useState({ top: 0, left: 0 });
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
    setChecked(new Set());
    setConfirmDelete(false);
    listRef.current?.scrollTo({ top: 0 });
    const timer = setTimeout(() => void loadPage(null), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadPage, query]);

  // Accounts' state every 15 s; new mail refreshes the top of the list.
  useEffect(() => {
    let alive = true;
    let ticks = 0;
    const tick = async () => {
      // Every minute while the screen is in view: ask the server for what changed elsewhere.
      if (ticks++ % 4 === 0 && document.visibilityState === "visible")
        void mailRefresh().catch(() => undefined);
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

  const compose = (draft: Draft) => {
    const id = uuid();
    setTabs((current) => [...current, { id, kind: "compose", draft, title: "", closing: false }]);
    setActive(id);
    setAgenda(false);
    setPane("message");
  };
  const openInTab = (messageId: string) => {
    const id = uuid();
    setTabs((current) => [...current, { id, kind: "message", messageId }]);
    setActive(id);
    setPane("message");
    setRows((current) =>
      current.map((item) => (item.id === messageId ? { ...item, seen: true } : item)),
    );
  };
  const closeTab = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((item) => item.id === id);
      const next = current.filter((item) => item.id !== id);
      if (active === id) setActive(next[Math.max(0, index - 1)]?.id ?? "read");
      return next;
    });
  };
  const patchTab = (id: string, change: Partial<Extract<Tab, { kind: "compose" }>>) =>
    setTabs((current) =>
      current.map((item) =>
        item.id === id && item.kind === "compose" ? { ...item, ...change } : item,
      ),
    );
  const open = (id: string) => {
    setActive("read");
    setSelected(id);
    setPane("message");
    setRows((current) => current.map((item) => (item.id === id ? { ...item, seen: true } : item)));
  };
  // Flags and read marks change at once in the list; the server confirms in the background.
  const mark = async (
    id: string,
    change: { seen?: boolean; flagged?: boolean; hidden?: boolean },
  ) => {
    setRows((current) =>
      current
        .map((item) => (item.id === id ? { ...item, ...change } : item))
        .filter((item) => !change.hidden || item.id !== id),
    );
    if (change.hidden && selected === id) setSelected(null);
    if (change.hidden) toast("Correo ocultado en Grafito.");
    const answer = await mailMark({ data: { id, ...change } }).catch(() => null);
    if (!answer?.ok) void loadPage(null);
  };
  /** A click on a row: open it; with Ctrl or ⌘ tick it; with Shift tick the run from the last. */
  const pick = (event: React.MouseEvent | React.KeyboardEvent, id: string) => {
    if (event.shiftKey && anchor.current) {
      const from = rows.findIndex((item) => item.id === anchor.current);
      const to = rows.findIndex((item) => item.id === id);
      if (from >= 0 && to >= 0) {
        const [low, high] = from < to ? [from, to] : [to, from];
        setChecked(new Set(rows.slice(low, high + 1).map((item) => item.id)));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      toggle(id);
      return;
    }
    anchor.current = id;
    if (checked.size) setChecked(new Set());
    open(id);
  };
  const toggle = (id: string) => {
    anchor.current = id;
    setConfirmDelete(false);
    setChecked((current) => {
      const next = new Set(current);
      // The message being read joins the first tick, as in Outlook.
      if (next.size === 0 && selected && selected !== id && !current.has(selected))
        next.add(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const inTrash =
    (view.kind === "role" && view.role === "trash") ||
    (view.kind === "folder" &&
      state?.folders.find((item) => item.id === view.folderId)?.specialUse === "trash");
  /** Delete messages on their servers: into the trash, or for good from the trash. */
  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    setRows((current) => current.filter((item) => !gone.has(item.id)));
    setChecked(new Set());
    setConfirmDelete(false);
    if (selected && gone.has(selected)) setSelected(null);
    setTabs((current) =>
      current.filter((item) => item.kind !== "message" || !gone.has(item.messageId)),
    );
    const answer = await mailDelete({ data: { ids } }).catch(() => null);
    if (!answer?.ok) {
      toast("No se pudo eliminar.");
      void loadPage(null);
      return;
    }
    toast(
      t(
        inTrash
          ? answer.deleted === 1
            ? "Mensaje eliminado definitivamente."
            : "{0} mensajes eliminados definitivamente."
          : answer.deleted === 1
            ? "Mensaje movido a la papelera."
            : "{0} mensajes movidos a la papelera.",
        { 0: answer.deleted },
      ),
    );
  };
  /** Mark every ticked message at once. */
  const markChecked = (change: { seen?: boolean; flagged?: boolean }) => {
    for (const id of checked) void mark(id, change);
    setChecked(new Set());
  };
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
    /** The account's own folders keep the usual, tighter rows. */
    compact = false,
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        onClick();
        setSelected(null);
        setPane("list");
      }}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center rounded-md text-left text-sm ${compact ? "h-9 gap-2 px-2" : "h-10 gap-2.5 px-2.5"} ${active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated"}`}
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
          className={`${pane === "nav" ? "flex" : "hidden"} w-full shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-3 md:flex md:w-64`}
        >
          <div className="flex items-center gap-2 px-2 py-2">
            <Mail className="size-4 text-accent" />
            <h1 className="flex-1 text-sm font-semibold">{t("Correo electrónico")}</h1>
            <div className="relative">
              <button
                type="button"
                aria-label={t("Opciones del correo")}
                title={t("Opciones del correo")}
                aria-haspopup="menu"
                aria-expanded={settings === "menu"}
                onClick={(event) => {
                  // Over the page (the column would clip it), clear of the window's edges.
                  const box = event.currentTarget.getBoundingClientRect();
                  const width = 240;
                  setSettingsAt({
                    top: box.bottom + 6,
                    left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)),
                  });
                  setSettings(settings === "menu" ? null : "menu");
                }}
                className="grid size-9 place-items-center rounded-md text-muted hover:bg-elevated"
              >
                <Settings className="size-4" />
              </button>
              {settings === "menu" ? (
                <>
                  <div className="fixed inset-0 z-30" onMouseDown={() => setSettings(null)} />
                  <div
                    role="menu"
                    data-ui="mail-settings-menu"
                    style={{ top: settingsAt.top, left: settingsAt.left }}
                    className="fixed z-40 w-60 rounded-lg border border-line bg-surface p-1.5 shadow-2xl"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setSettings("preferences")}
                      className="flex h-10 w-full items-center rounded-md px-3 text-left text-sm hover:bg-elevated"
                    >
                      {t("Preferencias")}
                    </button>
                    <Link
                      to="/account"
                      search={{ section: "mailboxes" }}
                      role="menuitem"
                      className="flex h-10 w-full items-center rounded-md px-3 text-left text-sm hover:bg-elevated"
                    >
                      {t("Cuentas de correo")}
                    </Link>
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              compose({
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
            className="mx-1 mb-3 inline-flex h-11 items-center justify-center gap-2 rounded-md bg-accent text-[0.95rem] font-medium text-accent-fg"
          >
            <PenSquare className="size-[1.125rem]" />
            {t("Redactar")}
          </button>
          <button
            type="button"
            data-ui="mail-agenda-entry"
            aria-current={agenda ? "page" : undefined}
            onClick={() => {
              setAgenda(true);
              setSelected(null);
              setPane("list");
            }}
            className={`flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm ${agenda ? "bg-elevated text-fg" : "text-muted hover:bg-elevated"}`}
          >
            <CalendarDays className="size-4" />
            <span className="min-w-0 flex-1 truncate">{t("Agenda")}</span>
          </button>
          <div className="my-2 border-t border-line" />
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
            <Flag className="size-4" />,
            t("Fichados"),
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
                      true,
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
                    true,
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
          {checked.size ? (
            <div
              data-ui="mail-bulk"
              className="flex flex-wrap items-center gap-1 border-b border-line bg-elevated px-2 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                aria-label={t("Seleccionar todos")}
                checked={checked.size === rows.length}
                onChange={(event) =>
                  setChecked(
                    event.target.checked ? new Set(rows.map((item) => item.id)) : new Set(),
                  )
                }
                className="mx-1 size-4 accent-[var(--color-accent)]"
              />
              <span className="mr-auto text-muted">
                {t("{0} seleccionados", { 0: checked.size })}
              </span>
              {confirmDelete ? (
                <>
                  <span className="text-danger">
                    {t("¿Eliminar definitivamente {0}?", { 0: checked.size })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove([...checked])}
                    className="h-8 rounded-md bg-danger px-3 text-white"
                  >
                    {t("Eliminar")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="h-8 rounded-md border border-line px-3 hover:bg-inset"
                  >
                    {t("Cancelar")}
                  </button>
                </>
              ) : (
                <>
                  <BulkButton label="Marcar como leído" onClick={() => markChecked({ seen: true })}>
                    <MailOpen className="size-4" />
                  </BulkButton>
                  <BulkButton
                    label="Marcar como no leído"
                    onClick={() => markChecked({ seen: false })}
                  >
                    <Mail className="size-4" />
                  </BulkButton>
                  <BulkButton label="Fichar" onClick={() => markChecked({ flagged: true })}>
                    <Flag className="size-4" />
                  </BulkButton>
                  <BulkButton
                    label="Eliminar"
                    danger
                    onClick={() => (inTrash ? setConfirmDelete(true) : void remove([...checked]))}
                  >
                    <Trash2 className="size-4" />
                  </BulkButton>
                  <BulkButton label="Quitar la selección" onClick={() => setChecked(new Set())}>
                    <X className="size-4" />
                  </BulkButton>
                </>
              )}
            </div>
          ) : null}
          <div
            ref={listRef}
            data-ui="mail-list"
            onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
            className="relative min-h-0 flex-1 overflow-y-auto select-none"
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
                  <div
                    key={row.id}
                    role="listitem"
                    tabIndex={0}
                    data-message={row.id}
                    data-flagged={row.flagged ? "" : undefined}
                    data-checked={checked.has(row.id) ? "" : undefined}
                    aria-current={selected === row.id ? "true" : undefined}
                    onMouseDown={(event) => {
                      // Shift and a click ticks a run; it must not select the rows' text.
                      if (event.shiftKey) event.preventDefault();
                    }}
                    onClick={(event) => pick(event, row.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter") pick(event, row.id);
                      else if (event.key === " ") {
                        event.preventDefault();
                        toggle(row.id);
                      } else if (event.key === "Delete")
                        void (inTrash
                          ? (setChecked(new Set(checked.size ? checked : [row.id])),
                            setConfirmDelete(true))
                          : remove(checked.size ? [...checked] : [row.id]));
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ x: event.clientX, y: event.clientY, id: row.id });
                    }}
                    style={{
                      position: "absolute",
                      top: (first + index) * ROW,
                      height: ROW,
                      left: 0,
                      right: 0,
                    }}
                    className={`group flex cursor-pointer gap-2 border-b border-line py-2 pr-3 pl-2 text-left ${checked.has(row.id) ? "bg-accent/10" : selected === row.id ? "bg-elevated" : "hover:bg-elevated"}`}
                  >
                    <span className="flex w-5 shrink-0 justify-center pt-0.5">
                      <input
                        type="checkbox"
                        data-ui="mail-check"
                        aria-label={t("Seleccionar {0}", {
                          0: row.subject || t("(sin asunto)"),
                        })}
                        checked={checked.has(row.id)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggle(row.id)}
                        className={`size-4 cursor-pointer accent-[var(--color-accent)] ${checked.size ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                        {/* Fixed slots on the right, so every row lines up whatever the sender. */}
                        <span
                          data-ui="mail-row-meta"
                          className="ml-auto flex shrink-0 items-center gap-1"
                        >
                          <span className="grid size-4 place-items-center">
                            {row.hasAttachments ? (
                              <Paperclip
                                aria-label={t("Con adjuntos")}
                                className="size-3.5 text-faint"
                              />
                            ) : null}
                          </span>
                          <button
                            type="button"
                            data-ui="mail-flag"
                            aria-label={row.flagged ? t("Quitar ficha") : t("Fichar")}
                            title={row.flagged ? t("Quitar ficha") : t("Fichar")}
                            aria-pressed={row.flagged}
                            onClick={(event) => {
                              event.stopPropagation();
                              void mark(row.id, { flagged: !row.flagged });
                            }}
                            className={`grid size-6 shrink-0 place-items-center rounded hover:bg-inset ${row.flagged ? "text-danger" : "text-faint opacity-60 group-hover:opacity-100"}`}
                          >
                            <Flag className={`size-3.5 ${row.flagged ? "fill-current" : ""}`} />
                          </button>
                          <time className="w-[7.5rem] shrink-0 text-right text-xs text-faint tabular-nums">
                            {new Date(row.receivedAt).toLocaleString(intl(), {
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                          </time>
                        </span>
                      </span>
                      <span className={`truncate text-sm ${row.seen ? "text-muted" : "text-fg"}`}>
                        {row.subject || t("(sin asunto)")}
                      </span>
                      <span className="truncate text-xs text-faint">
                        {multi ? `${accountName(row.accountId)} · ` : ""}
                        {row.snippet}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <section
          className={`${pane === "message" && !agenda ? "flex" : "hidden"} ${agenda ? "md:hidden" : selected || tabs.length ? "md:flex" : "md:hidden lg:flex"} min-w-0 flex-[1.4] flex-col`}
        >
          {selected || tabs.length ? (
            <div
              role="tablist"
              data-ui="mail-tabs"
              className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 pt-1"
            >
              <button
                type="button"
                aria-label={t("Volver a la lista")}
                onClick={() => setPane("list")}
                className="grid size-8 shrink-0 place-items-center rounded-md text-accent lg:hidden"
              >
                <ArrowLeft className="size-4" />
              </button>
              {selected ? (
                <TabButton
                  active={active === "read"}
                  title={rows.find((item) => item.id === selected)?.subject || t("Mensaje")}
                  onSelect={() => setActive("read")}
                  onClose={() => {
                    setSelected(null);
                    if (active === "read") setActive(tabs[0]?.id ?? "read");
                  }}
                />
              ) : null}
              {tabs.map((tab) => (
                <TabButton
                  key={tab.id}
                  active={active === tab.id}
                  compose={tab.kind === "compose"}
                  title={
                    tab.kind === "compose"
                      ? tab.title || t("Nuevo mensaje")
                      : rows.find((item) => item.id === tab.messageId)?.subject || t("Mensaje")
                  }
                  onSelect={() => setActive(tab.id)}
                  onClose={() => {
                    if (tab.kind === "compose") {
                      setActive(tab.id);
                      patchTab(tab.id, { closing: true });
                    } else closeTab(tab.id);
                  }}
                />
              ))}
            </div>
          ) : null}
          {selected ? (
            <div className={`${active === "read" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
              <MessageView
                key={selected}
                id={selected}
                onCompose={compose}
                onSchedule={setMeeting}
                intent={intent}
                onIntentDone={() => setIntent(null)}
                onChanged={(change) =>
                  setRows((current) =>
                    current
                      .map((row) => (row.id === selected ? { ...row, ...change } : row))
                      .filter((row) => !("hidden" in change) || row.id !== selected),
                  )
                }
              />
            </div>
          ) : null}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              data-tab={tab.kind}
              className={`${active === tab.id ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}
            >
              {tab.kind === "message" ? (
                <MessageView
                  id={tab.messageId}
                  onCompose={compose}
                  onSchedule={setMeeting}
                  onChanged={(change) =>
                    setRows((current) =>
                      current.map((row) =>
                        row.id === tab.messageId ? { ...row, ...change } : row,
                      ),
                    )
                  }
                />
              ) : (
                <Compose
                  draft={tab.draft}
                  accounts={accounts}
                  closing={tab.closing}
                  onCancelClose={() => patchTab(tab.id, { closing: false })}
                  onTitle={(title) => patchTab(tab.id, { title })}
                  onClosed={(outcome) => {
                    closeTab(tab.id);
                    if (outcome === "draft") {
                      toast("Borrador guardado.");
                      void loadState();
                    }
                  }}
                  onSent={(sentCopy) => {
                    closeTab(tab.id);
                    toast(
                      sentCopy
                        ? "Mensaje enviado."
                        : "Mensaje enviado; no se pudo guardar la copia en Enviados.",
                    );
                    void loadState();
                  }}
                />
              )}
            </div>
          ))}
          {!selected && tabs.length === 0 ? (
            <p className="grid flex-1 place-items-center text-sm text-faint">
              {t("Elige un mensaje.")}
            </p>
          ) : null}
        </section>
      </div>
      {menu ? (
        <RowMenu
          x={menu.x}
          y={menu.y}
          row={rows.find((item) => item.id === menu.id) ?? null}
          onClose={() => setMenu(null)}
          onOpen={(wanted) => {
            open(menu.id);
            setIntent(wanted);
          }}
          onOpenTab={() => openInTab(menu.id)}
          onMark={(change) => void mark(menu.id, change)}
          onDelete={() => {
            const ids = checked.has(menu.id) ? [...checked] : [menu.id];
            if (inTrash) {
              setChecked(new Set(ids));
              setConfirmDelete(true);
            } else void remove(ids);
          }}
        />
      ) : null}
      {meeting ? (
        <ScheduleMeeting
          accounts={accounts}
          prefill={meeting}
          onClose={() => setMeeting(null)}
          onDone={(invited) => {
            setMeeting(null);
            toast(
              invited ? "Reunión programada; se enviaron las invitaciones." : "Reunión programada.",
            );
          }}
        />
      ) : null}
      {settings === "preferences" ? (
        <MailPreferences
          accounts={accounts}
          onClose={() => setSettings(null)}
          onSaved={() => void loadState()}
        />
      ) : null}
      <Toaster />
    </AppFrame>
  );
}

type ListRow = { id: string; seen: boolean; flagged: boolean };

/** Right click on a message: the actions of the message itself, without opening it first. */
function RowMenu({
  x,
  y,
  row,
  onClose,
  onOpen,
  onOpenTab,
  onMark,
  onDelete,
}: {
  x: number;
  y: number;
  row: ListRow | null;
  onClose: () => void;
  onOpen: (intent: Intent | null) => void;
  onOpenTab: () => void;
  onMark: (change: { seen?: boolean; flagged?: boolean; hidden?: boolean }) => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  if (!row) return null;
  const item = (label: string, icon: React.ReactNode, run: () => void) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      onClick={() => {
        run();
        onClose();
      }}
      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-elevated"
    >
      {icon}
      {t(label)}
    </button>
  );
  const width = 240;
  const height = 416;
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onMouseDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        data-ui="mail-row-menu"
        style={{
          left: Math.min(x, window.innerWidth - width - 8),
          top: Math.min(y, window.innerHeight - height - 8),
          width,
        }}
        className="fixed z-50 rounded-md border border-line bg-surface py-1 shadow-2xl"
      >
        {item("Abrir", <Eye className="size-4 text-faint" />, () => onOpen(null))}
        {item(
          "Abrir en una nueva pestaña",
          <SquarePlus className="size-4 text-faint" />,
          onOpenTab,
        )}
        {item("Responder", <Reply className="size-4 text-faint" />, () => onOpen("reply"))}
        {item("Responder a todos", <ReplyAll className="size-4 text-faint" />, () =>
          onOpen("replyAll"),
        )}
        {item("Reenviar", <Forward className="size-4 text-faint" />, () => onOpen("forward"))}
        <div className="my-1 border-t border-line" />
        {row.seen
          ? item("Marcar como no leído", <MailOpen className="size-4 text-faint" />, () =>
              onMark({ seen: false }),
            )
          : item("Marcar como leído", <MailOpen className="size-4 text-faint" />, () =>
              onMark({ seen: true }),
            )}
        {item(
          row.flagged ? "Quitar ficha" : "Fichar",
          <Flag className={`size-4 ${row.flagged ? "fill-current text-danger" : "text-faint"}`} />,
          () => onMark({ flagged: !row.flagged }),
        )}
        <div className="my-1 border-t border-line" />
        {item("Programar reunión", <CalendarPlus className="size-4 text-faint" />, () =>
          onOpen("meeting"),
        )}
        {item("Archivar en Grafito", <ArchiveIcon className="size-4 text-faint" />, () =>
          onOpen("archive"),
        )}
        {item("Ocultar aquí", <EyeOff className="size-4 text-faint" />, () =>
          onMark({ hidden: true }),
        )}
        {item("Eliminar", <Trash2 className="size-4 text-danger" />, onDelete)}
      </div>
    </>
  );
}

function BulkButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={t(label)}
      onClick={onClick}
      className={`grid size-8 place-items-center rounded-md hover:bg-inset ${danger ? "text-danger" : "text-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  title,
  compose = false,
  onSelect,
  onClose,
}: {
  active: boolean;
  title: string;
  compose?: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      data-ui="mail-tab"
      data-compose={compose ? "" : undefined}
      className={`flex h-9 max-w-56 shrink-0 items-center gap-1 rounded-t-md border border-b-0 pl-3 text-sm ${active ? "border-line bg-elevated text-fg" : "border-transparent text-muted hover:bg-elevated"}`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
        {compose ? <PenSquare className="mr-1.5 inline size-3.5 align-[-2px] text-accent" /> : null}
        {title}
      </button>
      <button
        type="button"
        aria-label={t("Cerrar {0}", { 0: title })}
        onClick={onClose}
        className="grid size-7 shrink-0 place-items-center rounded text-faint"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
