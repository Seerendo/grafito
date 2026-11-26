import { ArrowLeft, ChevronLeft, ChevronRight, MapPin, Plus, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { MailSearch } from "@/routes/mail";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import {
  mailCalendars,
  mailDeleteEvent,
  mailEvents,
  mailFindCalendars,
  mailRespondEvent,
  mailSaveEvent,
  mailShowCalendar,
} from "@/server/mailbox.functions";
import { Recipients } from "./Compose";
import { eventStyle, type Answer } from "@/app/mail/meeting-style";
import { AnswerBadge, AnswerButtons, EventIcons } from "./meeting";

/**
 * Agenda: the calendars of the person's mail accounts (CalDAV: Zimbra and others), month or
 * week, with the server as the only source. Events are read for the range on screen; creating,
 * changing or deleting one goes straight to the server, which sends invitations when it handles
 * scheduling. Repeating events show every occurrence and are changed on the mail server.
 */

type Account = { id: string; email: string; provider: string; hasSecret: boolean };
type Calendars = Extract<Awaited<ReturnType<typeof mailCalendars>>, { ok: true }>["calendars"];
type Calendar = Calendars[number];
type Events = Extract<Awaited<ReturnType<typeof mailEvents>>, { ok: true }>["events"];
type Event = Events[number];

const PALETTE = ["#d97706", "#2563eb", "#059669", "#db2777", "#7c3aed", "#0891b2"];

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Weeks start on Monday. */
function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - offset);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(intl(), { hour: "2-digit", minute: "2-digit" });
}

/** The days an event covers on screen (all-day end dates are exclusive). */
function covers(event: Event, day: Date): boolean {
  if (event.allDay) {
    const key = dateKey(day);
    return key >= event.startDate && key < event.endDate;
  }
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return (
    event.start < to && (event.end > from || (event.end === event.start && event.start >= from))
  );
}

type Mode = "day" | "week" | "month" | "list";

const MODES: { id: Mode; label: string }[] = [
  { id: "day", label: "Día" },
  { id: "week", label: "Semana" },
  { id: "month", label: "Mes" },
  { id: "list", label: "Lista" },
];

/** One event in a day cell or a list: its color and look follow this account's answer. */
function EventPill({
  event,
  color,
  wide = false,
  onOpen,
}: {
  event: Event;
  color: string;
  wide?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-event={event.title}
      data-answer={event.mine || undefined}
      onClick={onOpen}
      title={event.title}
      className={`flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs hover:brightness-110 ${wide ? "h-9 w-full text-sm" : ""}`}
      style={eventStyle(event.mine, color)}
    >
      {event.allDay ? null : <span className="shrink-0 text-faint">{time(event.start)}</span>}
      <span
        className={`min-w-0 flex-1 truncate ${event.mine === "DECLINED" ? "line-through" : ""}`}
      >
        {event.title || t("(sin título)")}
      </span>
      <EventIcons
        recurring={event.recurring}
        meeting={event.attendees.length > 0}
        mine={event.mine}
      />
      {wide && event.location ? (
        <span className="truncate text-xs text-faint">{event.location}</span>
      ) : null}
    </button>
  );
}

const HOUR = 44;

/** Day and week views: all-day events on top, the others placed by their hours. */
function TimeGrid({
  days,
  events,
  today,
  colorOf,
  onOpen,
  onCreate,
}: {
  days: Date[];
  events: Events;
  today: string;
  colorOf: (id: string) => string;
  onOpen: (event: Event) => void;
  onCreate: (day: Date) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const columns = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;
  // The working day in view first (from 7:00).
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 7 * HOUR });
  }, []);
  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto"
      data-mode={days.length === 1 ? "day" : "week"}
    >
      <div
        className="sticky top-0 z-10 grid border-b border-line bg-surface"
        style={{ gridTemplateColumns: columns }}
      >
        <span />
        {days.map((day) => {
          const key = dateKey(day);
          return (
            <div key={key} className="flex flex-col gap-1 border-l border-line p-1.5">
              <span
                className={`text-xs capitalize ${key === today ? "font-semibold text-accent" : "text-muted"}`}
              >
                {day.toLocaleDateString(intl(), { weekday: "short", day: "numeric" })}
              </span>
              {events
                .filter((event) => event.allDay && covers(event, day))
                .map((event) => (
                  <EventPill
                    key={`${event.id}:${key}`}
                    event={event}
                    color={colorOf(event.calendarId)}
                    onOpen={() => onOpen(event)}
                  />
                ))}
            </div>
          );
        })}
      </div>
      <div className="relative grid" style={{ gridTemplateColumns: columns }}>
        <div>
          {hours.map((hour) => (
            <div
              key={hour}
              style={{ height: HOUR }}
              className="pr-1 text-right text-[0.65rem] text-faint"
            >
              {String(hour).padStart(2, "0")}:00
            </div>
          ))}
        </div>
        {days.map((day) => {
          const key = dateKey(day);
          const from = day.getTime();
          const timed = events
            .filter((event) => !event.allDay && covers(event, day))
            .map((event) => ({
              event,
              top: Math.max(0, (event.start - from) / 3_600_000),
              bottom: Math.min(
                24,
                (Math.max(event.end, event.start + 1_800_000) - from) / 3_600_000,
              ),
            }))
            .sort((a, b) => a.top - b.top);
          // Overlapping events share the column side by side.
          const lanes: number[] = [];
          const placed = timed.map((item) => {
            let lane = lanes.findIndex((end) => end <= item.top);
            if (lane === -1) {
              lane = lanes.length;
              lanes.push(item.bottom);
            } else lanes[lane] = item.bottom;
            return { ...item, lane };
          });
          const width = 100 / Math.max(1, lanes.length);
          return (
            <div
              key={key}
              data-day={key}
              onDoubleClick={() => onCreate(day)}
              className={`relative border-l border-line ${key === today ? "bg-accent/5" : ""}`}
              style={{ height: HOUR * 24 }}
            >
              {hours.map((hour) => (
                <div
                  key={hour}
                  style={{ top: hour * HOUR }}
                  className="absolute right-0 left-0 border-t border-line/60"
                />
              ))}
              {placed.map(({ event, top, bottom, lane }) => (
                <button
                  key={`${event.id}:${key}`}
                  type="button"
                  data-event={event.title}
                  data-answer={event.mine || undefined}
                  onClick={() => onOpen(event)}
                  title={event.title}
                  className="absolute flex flex-col overflow-hidden rounded px-1.5 py-0.5 text-left text-xs hover:brightness-110"
                  style={{
                    top: top * HOUR,
                    height: Math.max(20, (bottom - top) * HOUR - 2),
                    left: `${lane * width}%`,
                    width: `calc(${width}% - 2px)`,
                    ...eventStyle(event.mine, colorOf(event.calendarId)),
                  }}
                >
                  <span className="flex items-center gap-1">
                    <span
                      className={`min-w-0 flex-1 truncate font-medium ${event.mine === "DECLINED" ? "line-through" : ""}`}
                    >
                      {event.title || t("(sin título)")}
                    </span>
                    <EventIcons
                      recurring={event.recurring}
                      meeting={event.attendees.length > 0}
                      mine={event.mine}
                    />
                  </span>
                  <span className="truncate text-faint">
                    {time(event.start)} – {time(event.end)}
                    {event.location ? ` · ${event.location}` : ""}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Agenda({
  accounts,
  className,
  onBack,
}: {
  accounts: Account[];
  className: string;
  onBack: () => void;
}) {
  const [calendars, setCalendars] = useState<Calendars | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  // The view and the date shown live in the address (/mail/calendar?view=week&date=…).
  const search = useSearch({ strict: false }) as MailSearch;
  const navigate = useNavigate();
  const mode: Mode = MODES.some((item) => item.id === search.view)
    ? (search.view as Mode)
    : "month";
  const anchor = useMemo(
    () =>
      search.date && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
        ? fromKey(search.date)
        : startOfDay(new Date()),
    [search.date],
  );
  const go = (next: { mode?: Mode; anchor?: Date }) =>
    void navigate({
      to: "/mail/calendar",
      search: {
        view: next.mode ?? mode,
        date: dateKey(next.anchor ?? anchor),
      },
      replace: true,
    });
  const setMode = (value: Mode) => go({ mode: value });
  const setAnchor = (value: Date | ((current: Date) => Date)) =>
    go({ anchor: typeof value === "function" ? value(anchor) : value });
  const [events, setEvents] = useState<Events>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Event | null>(null);
  const [creating, setCreating] = useState<Date | null>(null);
  const [searching, setSearching] = useState(false);

  const range = useMemo(() => {
    if (mode === "day") return { from: anchor, to: addDays(anchor, 1), days: 1 };
    if (mode === "week" || mode === "list") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, mode === "list" ? 14 : 7), days: mode === "list" ? 14 : 7 };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const from = startOfWeek(first);
    return { from, to: addDays(from, 42), days: 42 };
  }, [mode, anchor]);

  const accountKey = accounts
    .filter((item) => item.provider === "imap" && item.hasSecret)
    .map((item) => item.id)
    .join(",");
  const request = useRef(0);

  const find = useCallback(async () => {
    setSearching(true);
    const found: string[] = [];
    for (const account of accounts.filter((item) => item.provider === "imap" && item.hasSecret)) {
      const answer = await mailFindCalendars({ data: { accountId: account.id } }).catch(() => null);
      if (!answer?.ok)
        found.push(`${account.email}: ${t(answer?.error ?? "No se pudo completar.")}`);
    }
    setProblems(found);
    const listed = await mailCalendars().catch(() => null);
    if (listed?.ok) setCalendars(listed.calendars);
    setSearching(false);
    // Only when the accounts themselves change, not on every refresh of their state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  useEffect(() => {
    void mailCalendars()
      .then((answer) => {
        if (!answer.ok) return setCalendars((current) => current ?? []);
        if (answer.calendars.length === 0) void find();
        else setCalendars(answer.calendars);
      })
      .catch(() => setCalendars((current) => current ?? []));
  }, [find]);

  const load = useCallback(async () => {
    if (!calendars?.length) {
      setEvents([]);
      return;
    }
    // Only the latest request counts: an older answer arriving late does not replace it.
    const ticket = ++request.current;
    setLoading(true);
    const from = range.from.getTime();
    const to = range.to.getTime();
    const answer = await mailEvents({ data: { from, to } }).catch(() => null);
    if (ticket !== request.current) return;
    setLoading(false);
    if (answer?.ok) {
      // A calendar that failed this time keeps the events it had on screen in this range.
      setEvents((current) =>
        [
          ...answer.events,
          ...current.filter(
            (event) =>
              answer.failed.includes(event.calendarId) && event.start < to && event.end >= from,
          ),
        ].sort((a, b) => a.start - b.start),
      );
      setProblems(answer.problems);
    } else setProblems([answer?.error ?? "No se pudo leer la agenda."]);
  }, [calendars, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const colorOf = (id: string) => {
    const index = calendars?.findIndex((item) => item.id === id) ?? 0;
    const calendar = calendars?.[index];
    return calendar?.color || PALETTE[Math.max(index, 0) % PALETTE.length]!;
  };
  const toggle = async (calendar: Calendar) => {
    await mailShowCalendar({ data: { id: calendar.id, shown: !calendar.shown } }).catch(() => null);
    setCalendars((current) =>
      (current ?? []).map((item) =>
        item.id === calendar.id ? { ...item, shown: !item.shown } : item,
      ),
    );
  };
  const move = (step: number) =>
    setAnchor((current) =>
      mode === "day"
        ? addDays(current, step)
        : mode === "week"
          ? addDays(current, step * 7)
          : mode === "list"
            ? addDays(current, step * 14)
            : new Date(current.getFullYear(), current.getMonth() + step, 1),
    );
  const title =
    mode === "month"
      ? anchor.toLocaleDateString(intl(), { month: "long", year: "numeric" })
      : mode === "day"
        ? anchor.toLocaleDateString(intl(), { dateStyle: "full" })
        : `${range.from.toLocaleDateString(intl(), { day: "numeric", month: "short" })} – ${addDays(range.to, -1).toLocaleDateString(intl(), { day: "numeric", month: "short", year: "numeric" })}`;
  const days = Array.from({ length: range.days }, (_, index) => addDays(range.from, index));
  const today = dateKey(new Date());
  const writable = (calendars ?? []).filter((item) => item.writable && item.shown);
  const names = Array.from({ length: 7 }, (_, index) =>
    addDays(startOfWeek(new Date()), index).toLocaleDateString(intl(), { weekday: "short" }),
  );

  return (
    <section data-ui="mail-agenda" className={`${className} min-h-0 flex-col`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <button
          type="button"
          aria-label={t("Atrás")}
          onClick={onBack}
          className="grid size-9 place-items-center rounded-md hover:bg-elevated md:hidden"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setAnchor(startOfDay(new Date()))}
          className="h-9 rounded-md border border-line px-3 text-sm hover:bg-elevated"
        >
          {t("Hoy")}
        </button>
        <button
          type="button"
          aria-label={t("Anterior")}
          onClick={() => move(-1)}
          className="grid size-9 place-items-center rounded-md hover:bg-elevated"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t("Siguiente")}
          onClick={() => move(1)}
          className="grid size-9 place-items-center rounded-md hover:bg-elevated"
        >
          <ChevronRight className="size-4" />
        </button>
        <h2
          data-ui="agenda-title"
          className="min-w-0 flex-1 truncate text-base font-semibold first-letter:uppercase"
        >
          {title}
        </h2>
        <div className="flex rounded-md border border-line text-sm">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
              className={`h-9 px-3 first:rounded-l-md last:rounded-r-md ${mode === item.id ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("Buscar calendarios")}
          title={t("Buscar calendarios")}
          disabled={searching}
          onClick={() => void find()}
          className="grid size-9 place-items-center rounded-md hover:bg-elevated disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${searching || loading ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          disabled={writable.length === 0}
          onClick={() => setCreating(startOfDay(new Date()))}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          <Plus className="size-4" />
          {t("Nuevo evento")}
        </button>
      </header>
      {calendars?.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
          {calendars.map((calendar) => (
            <label key={calendar.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={calendar.shown}
                onChange={() => void toggle(calendar)}
                style={{ accentColor: colorOf(calendar.id) }}
              />
              <span
                className="size-2.5 rounded-full"
                style={{ background: colorOf(calendar.id) }}
              />
              {calendar.name}
              <span className="text-faint">{calendar.accountEmail}</span>
            </label>
          ))}
        </div>
      ) : null}
      {problems.length ? (
        <div role="alert" className="border-b border-line px-3 py-2 text-xs text-danger">
          {problems.map((item) => (
            <p key={item}>{t(item)}</p>
          ))}
        </div>
      ) : null}
      {calendars === null ? (
        <p className="p-6 text-sm text-faint">{t("Cargando…")}</p>
      ) : mode === "month" ? (
        <div
          className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(7rem,1fr))] overflow-y-auto"
          data-mode={mode}
        >
          {names.map((name) => (
            <p
              key={name}
              className="sticky top-0 z-10 border-b border-line bg-surface px-2 py-1.5 text-xs font-medium text-faint capitalize"
            >
              {name}
            </p>
          ))}
          {days.map((day) => {
            const key = dateKey(day);
            const items = events.filter((event) => covers(event, day));
            const outside = day.getMonth() !== anchor.getMonth();
            const limit = 3;
            return (
              <div
                key={key}
                data-day={key}
                onDoubleClick={() => writable.length && setCreating(day)}
                className={`flex min-h-28 flex-col gap-1 border-r border-b border-line p-1.5 ${outside ? "bg-inset/40" : ""} ${key === today ? "bg-accent/5" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setMode("day");
                    setAnchor(day);
                  }}
                  className={`grid size-6 place-items-center self-start rounded-full text-xs ${key === today ? "bg-accent font-semibold text-accent-fg" : outside ? "text-faint" : "text-muted hover:bg-elevated"}`}
                >
                  {day.getDate()}
                </button>
                {items.slice(0, limit).map((event) => (
                  <EventPill
                    key={`${event.id}:${key}`}
                    event={event}
                    color={colorOf(event.calendarId)}
                    onOpen={() => setOpen(event)}
                  />
                ))}
                {items.length > limit ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("day");
                      setAnchor(day);
                    }}
                    className="px-1 text-left text-xs text-faint hover:text-fg"
                  >
                    {t("{0} más", { 0: items.length - limit })}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : mode === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto" data-mode={mode}>
          {days
            .map((day) => ({ day, items: events.filter((event) => covers(event, day)) }))
            .filter((group) => group.items.length)
            .map((group) => (
              <section key={dateKey(group.day)} className="border-b border-line">
                <h3
                  className={`sticky top-0 bg-surface px-4 py-2 text-xs font-semibold capitalize ${dateKey(group.day) === today ? "text-accent" : "text-muted"}`}
                >
                  {group.day.toLocaleDateString(intl(), { dateStyle: "full" })}
                </h3>
                <ul className="flex flex-col gap-1 px-3 pb-3">
                  {group.items.map((event) => (
                    <li key={`${event.id}:${dateKey(group.day)}`}>
                      <EventPill
                        event={event}
                        color={colorOf(event.calendarId)}
                        wide
                        onOpen={() => setOpen(event)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          {events.length === 0 ? (
            <p className="p-6 text-center text-sm text-faint">{t("No hay eventos.")}</p>
          ) : null}
        </div>
      ) : (
        <TimeGrid
          days={days}
          events={events}
          today={today}
          colorOf={colorOf}
          onOpen={setOpen}
          onCreate={(day) => writable.length && setCreating(day)}
        />
      )}
      {open ? (
        <EventDialog
          event={open}
          calendars={writable}
          calendarName={calendars?.find((item) => item.id === open.calendarId)?.name ?? ""}
          editable={Boolean(
            calendars?.find((item) => item.id === open.calendarId)?.writable &&
            !open.recurring &&
            open.organizerMe,
          )}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void load();
          }}
        />
      ) : null}
      {creating ? (
        <EventDialog
          day={creating}
          calendars={writable}
          calendarName=""
          editable
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function hhmm(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function at(day: string, clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  const date = fromKey(day);
  date.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return date.getTime();
}

/** An event: read it, or (when the calendar allows) change it, invite people, delete it. */
function EventDialog({
  event,
  day,
  prefill,
  calendars,
  calendarName,
  editable,
  onClose,
  onSaved,
}: {
  event?: Event;
  day?: Date;
  /** A meeting started from a message: its subject, people and text. */
  prefill?: { title: string; attendees: string[]; description: string };
  calendars: Calendar[];
  calendarName: string;
  editable: boolean;
  onClose: () => void;
  onSaved: (invited: number) => void;
}) {
  const startDay = event
    ? event.allDay
      ? event.startDate
      : dateKey(new Date(event.start))
    : dateKey(day ?? new Date());
  const endDay = event
    ? event.allDay
      ? dateKey(addDays(fromKey(event.endDate), -1))
      : dateKey(new Date(event.end))
    : startDay;
  const [form, setForm] = useState({
    calendarId: event?.calendarId ?? calendars[0]?.id ?? "",
    title: event?.title ?? prefill?.title ?? "",
    allDay: event?.allDay ?? false,
    startDay,
    endDay,
    startTime: event && !event.allDay ? hhmm(event.start) : "09:00",
    endTime: event && !event.allDay ? hhmm(event.end) : "10:00",
    location: event?.location ?? "",
    description: event?.description ?? prefill?.description ?? "",
    attendees: event
      ? event.attendees
          .map(
            (item) =>
              `${item.name ? `${item.name.replace(/[<>,;"]/g, "")} <${item.address}>` : item.address}, `,
          )
          .join("")
      : (prefill?.attendees ?? []).map((item) => `${item}, `).join(""),
  });
  const [editing, setEditing] = useState(!event);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const answer = await mailSaveEvent({
      data: {
        calendarId: form.calendarId,
        href: event?.href ?? null,
        etag: event?.etag ?? null,
        title: form.title,
        allDay: form.allDay,
        start: at(form.startDay, form.startTime),
        end: at(form.endDay, form.endTime),
        startDate: form.startDay,
        endDate: dateKey(addDays(fromKey(form.endDay), 1)),
        location: form.location,
        description: form.description,
        attendees: form.attendees
          .split(/[,;]/)
          .map((item) => /<([^<>]+)>/.exec(item)?.[1] ?? item)
          .map((item) => item.trim())
          .filter(Boolean),
      },
    }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onSaved(answer.invited);
    else setError(answer?.error ?? "No se pudo guardar.");
  };
  const respond = async (value: Answer) => {
    if (!event) return;
    setBusy(true);
    setError("");
    const answer = await mailRespondEvent({
      data: { calendarId: event.calendarId, href: event.href, etag: event.etag, answer: value },
    }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onSaved(0);
    else setError(answer?.error ?? "No se pudo responder.");
  };
  const remove = async () => {
    if (!event) return;
    setBusy(true);
    const answer = await mailDeleteEvent({
      data: { calendarId: event.calendarId, href: event.href, etag: event.etag },
    }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onSaved(0);
    else setError(answer?.error ?? "No se pudo borrar.");
  };
  const input = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

  if (event && !editing) {
    const when = event.allDay
      ? event.startDate === dateKey(addDays(fromKey(event.endDate), -1))
        ? fromKey(event.startDate).toLocaleDateString(intl(), { dateStyle: "full" })
        : `${fromKey(event.startDate).toLocaleDateString(intl(), { dateStyle: "long" })} – ${addDays(fromKey(event.endDate), -1).toLocaleDateString(intl(), { dateStyle: "long" })}`
      : `${new Date(event.start).toLocaleString(intl(), { dateStyle: "full", timeStyle: "short" })} – ${time(event.end)}`;
    return (
      <Modal title={event.title || t("(sin título)")} onClose={onClose}>
        <div data-ui="agenda-event" className="flex flex-col gap-2 text-sm">
          <p>{when}</p>
          <p className="flex items-center gap-2 text-xs text-faint">
            {calendarName}
            <EventIcons
              recurring={event.recurring}
              meeting={event.attendees.length > 0}
              mine={event.mine}
            />
          </p>
          {event.mine ? (
            <AnswerButtons
              mine={event.mine}
              busy={busy}
              onAnswer={(value) => void respond(value)}
            />
          ) : null}
          {event.location ? (
            <p className="flex items-center gap-1.5">
              <MapPin className="size-4 text-faint" />
              {event.location}
            </p>
          ) : null}
          {event.attendees.length ? (
            <div className="flex items-start gap-1.5">
              <Users className="mt-0.5 size-4 shrink-0 text-faint" />
              <ul className="flex flex-col gap-0.5">
                {event.organizer ? (
                  <li className="text-xs text-faint">
                    {t("Organiza")}: {event.organizer}
                  </li>
                ) : null}
                {event.attendees.map((item) => (
                  <li key={item.address} className="flex flex-wrap items-center gap-2">
                    {item.name || item.address}
                    <AnswerBadge status={item.status} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {event.description ? (
            <p className="max-h-60 overflow-y-auto whitespace-pre-wrap text-muted">
              {event.description}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-danger">
              {t(error)}
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            {editable ? (
              confirm ? (
                <>
                  <span className="self-center text-xs">{t("¿Borrar el evento?")}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="h-10 rounded-md bg-danger px-3 text-accent-fg"
                  >
                    {t("Sí")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirm(false)}
                    className="h-10 rounded-md border border-line px-3"
                  >
                    {t("No")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirm(true)}
                    className="h-10 rounded-md border border-line px-3 text-danger hover:bg-elevated"
                  >
                    {t("Borrar")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="h-10 rounded-md bg-accent px-4 font-medium text-accent-fg"
                  >
                    {t("Editar")}
                  </button>
                </>
              )
            ) : null}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={event ? t("Editar evento") : prefill ? t("Programar reunión") : t("Nuevo evento")}
      onClose={onClose}
    >
      <form
        data-ui="agenda-form"
        className="flex flex-col gap-3 text-sm"
        onSubmit={(submit) => {
          submit.preventDefault();
          void save();
        }}
      >
        {!event ? (
          <label className="flex flex-col gap-1">
            {t("Calendario")}
            <select
              aria-label={t("Calendario")}
              value={form.calendarId}
              onChange={(change) => setForm({ ...form, calendarId: change.target.value })}
              className={input}
            >
              {calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name} · {calendar.accountEmail}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          {t("Título")}
          <input
            required
            aria-label={t("Título")}
            value={form.title}
            onChange={(change) => setForm({ ...form, title: change.target.value })}
            className={input}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.allDay}
            onChange={(change) => setForm({ ...form, allDay: change.target.checked })}
          />
          {t("Todo el día")}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            {t("Empieza")}
            <input
              type="date"
              aria-label={t("Empieza")}
              value={form.startDay}
              onChange={(change) =>
                setForm({
                  ...form,
                  startDay: change.target.value,
                  endDay: form.endDay < change.target.value ? change.target.value : form.endDay,
                })
              }
              className={input}
            />
          </label>
          {form.allDay ? (
            <span />
          ) : (
            <label className="flex flex-col gap-1">
              {t("Hora de inicio")}
              <input
                type="time"
                aria-label={t("Hora de inicio")}
                value={form.startTime}
                onChange={(change) => setForm({ ...form, startTime: change.target.value })}
                className={input}
              />
            </label>
          )}
          <label className="flex flex-col gap-1">
            {t("Termina")}
            <input
              type="date"
              aria-label={t("Termina")}
              value={form.endDay}
              min={form.startDay}
              onChange={(change) => setForm({ ...form, endDay: change.target.value })}
              className={input}
            />
          </label>
          {form.allDay ? (
            <span />
          ) : (
            <label className="flex flex-col gap-1">
              {t("Hora de fin")}
              <input
                type="time"
                aria-label={t("Hora de fin")}
                value={form.endTime}
                onChange={(change) => setForm({ ...form, endTime: change.target.value })}
                className={input}
              />
            </label>
          )}
        </div>
        <label className="flex flex-col gap-1">
          {t("Lugar")}
          <input
            aria-label={t("Lugar")}
            value={form.location}
            onChange={(change) => setForm({ ...form, location: change.target.value })}
            className={input}
          />
        </label>
        <Recipients
          label="Invitados"
          value={form.attendees}
          onChange={(attendees) => setForm((current) => ({ ...current, attendees }))}
        />
        <label className="flex flex-col gap-1">
          {t("Descripción")}
          <textarea
            aria-label={t("Descripción")}
            rows={4}
            value={form.description}
            onChange={(change) => setForm({ ...form, description: change.target.value })}
            className="w-full rounded-md border border-line bg-inset p-3"
          />
        </label>
        {error ? (
          <p role="alert" className="text-danger">
            {t(error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-line px-3 hover:bg-elevated"
          >
            {t("Cancelar")}
          </button>
          <button
            type="submit"
            disabled={busy || !form.calendarId}
            className="h-10 rounded-md bg-accent px-4 font-medium text-accent-fg disabled:opacity-50"
          >
            {busy ? t("Guardando…") : t("Guardar")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * «Programar reunión» from a message: the event form with the message's subject and people,
 * in a calendar of the person's accounts (looked up first when none is known yet).
 */
export function ScheduleMeeting({
  accounts,
  prefill,
  onClose,
  onDone,
}: {
  accounts: Account[];
  prefill: { title: string; attendees: string[]; description: string };
  onClose: () => void;
  onDone: (invited: number) => void;
}) {
  const [calendars, setCalendars] = useState<Calendars | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      let listed = await mailCalendars().catch(() => null);
      if (listed?.ok && listed.calendars.length === 0) {
        for (const account of accounts.filter(
          (item) => item.provider === "imap" && item.hasSecret,
        )) {
          const found = await mailFindCalendars({ data: { accountId: account.id } }).catch(
            () => null,
          );
          if (!found?.ok && found?.error) setProblem(found.error);
        }
        listed = await mailCalendars().catch(() => null);
      }
      if (alive) setCalendars(listed?.ok ? listed.calendars.filter((item) => item.writable) : []);
    })();
    return () => {
      alive = false;
    };
  }, [accounts]);
  if (calendars === null)
    return (
      <Modal title={t("Programar reunión")} onClose={onClose}>
        <p className="text-sm text-faint">{t("Cargando…")}</p>
      </Modal>
    );
  if (calendars.length === 0)
    return (
      <Modal title={t("Programar reunión")} onClose={onClose}>
        <p role="alert" className="text-sm text-danger">
          {t(problem || "No hay un calendario donde crear la reunión.")}
        </p>
      </Modal>
    );
  return (
    <EventDialog
      day={new Date()}
      prefill={prefill}
      calendars={calendars}
      calendarName=""
      editable
      onClose={onClose}
      onSaved={onDone}
    />
  );
}
