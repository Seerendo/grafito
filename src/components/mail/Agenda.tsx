import { ArrowLeft, ChevronLeft, ChevronRight, MapPin, Plus, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import {
  mailCalendars,
  mailDeleteEvent,
  mailEvents,
  mailFindCalendars,
  mailSaveEvent,
  mailShowCalendar,
} from "@/server/mailbox.functions";
import { Recipients } from "./Compose";

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
  const [mode, setMode] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<Events>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Event | null>(null);
  const [creating, setCreating] = useState<Date | null>(null);
  const [searching, setSearching] = useState(false);

  const range = useMemo(() => {
    if (mode === "week") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7), days: 7 };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const from = startOfWeek(first);
    return { from, to: addDays(from, 42), days: 42 };
  }, [mode, anchor]);

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
    setCalendars(listed?.ok ? listed.calendars : []);
    setSearching(false);
  }, [accounts]);

  useEffect(() => {
    void mailCalendars()
      .then((answer) => {
        if (!answer.ok) return setCalendars([]);
        if (answer.calendars.length === 0) void find();
        else setCalendars(answer.calendars);
      })
      .catch(() => setCalendars([]));
  }, [find]);

  const load = useCallback(async () => {
    if (!calendars?.length) {
      setEvents([]);
      return;
    }
    setLoading(true);
    const answer = await mailEvents({
      data: { from: range.from.getTime(), to: range.to.getTime() },
    }).catch(() => null);
    setLoading(false);
    if (answer?.ok) {
      setEvents(answer.events);
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
      mode === "week"
        ? addDays(current, step * 7)
        : new Date(current.getFullYear(), current.getMonth() + step, 1),
    );
  const title =
    mode === "month"
      ? anchor.toLocaleDateString(intl(), { month: "long", year: "numeric" })
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
          {(["week", "month"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
              className={`h-9 px-3 ${mode === item ? "bg-elevated text-fg" : "text-muted"}`}
            >
              {item === "week" ? t("Semana") : t("Mes")}
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
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto" data-mode={mode}>
          {names.map((name) => (
            <p
              key={name}
              className="sticky top-0 z-10 border-b border-line bg-surface px-2 py-1 text-xs text-faint capitalize"
            >
              {name}
            </p>
          ))}
          {days.map((day) => {
            const key = dateKey(day);
            const items = events.filter((event) => covers(event, day));
            const outside = mode === "month" && day.getMonth() !== anchor.getMonth();
            const limit = mode === "month" ? 3 : 50;
            return (
              <div
                key={key}
                data-day={key}
                onDoubleClick={() => writable.length && setCreating(day)}
                className={`flex flex-col gap-0.5 border-r border-b border-line p-1 ${mode === "month" ? "min-h-24" : "min-h-80"} ${outside ? "bg-inset/40" : ""}`}
              >
                <span
                  className={`self-start rounded-full px-1.5 text-xs ${key === today ? "bg-accent text-accent-fg" : outside ? "text-faint" : "text-muted"}`}
                >
                  {day.getDate()}
                </span>
                {items.slice(0, limit).map((event) => (
                  <button
                    key={`${event.id}:${key}`}
                    type="button"
                    data-event={event.title}
                    onClick={() => setOpen(event)}
                    className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-elevated"
                    style={{ borderLeft: `3px solid ${colorOf(event.calendarId)}` }}
                  >
                    {event.allDay ? null : (
                      <span className="shrink-0 text-faint">{time(event.start)}</span>
                    )}
                    <span className="truncate">{event.title || t("(sin título)")}</span>
                  </button>
                ))}
                {items.length > limit ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("week");
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
      )}
      {open ? (
        <EventDialog
          event={open}
          calendars={writable}
          calendarName={calendars?.find((item) => item.id === open.calendarId)?.name ?? ""}
          editable={Boolean(
            calendars?.find((item) => item.id === open.calendarId)?.writable && !open.recurring,
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
  calendars,
  calendarName,
  editable,
  onClose,
  onSaved,
}: {
  event?: Event;
  day?: Date;
  calendars: Calendar[];
  calendarName: string;
  editable: boolean;
  onClose: () => void;
  onSaved: () => void;
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
    title: event?.title ?? "",
    allDay: event?.allDay ?? false,
    startDay,
    endDay,
    startTime: event && !event.allDay ? hhmm(event.start) : "09:00",
    endTime: event && !event.allDay ? hhmm(event.end) : "10:00",
    location: event?.location ?? "",
    description: event?.description ?? "",
    attendees: (event?.attendees ?? []).map((item) => item.address).join(", "),
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
    if (answer?.ok) onSaved();
    else setError(answer?.error ?? "No se pudo guardar.");
  };
  const remove = async () => {
    if (!event) return;
    setBusy(true);
    const answer = await mailDeleteEvent({
      data: { calendarId: event.calendarId, href: event.href, etag: event.etag },
    }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onSaved();
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
          <p className="text-xs text-faint">{calendarName}</p>
          {event.location ? (
            <p className="flex items-center gap-1.5">
              <MapPin className="size-4 text-faint" />
              {event.location}
            </p>
          ) : null}
          {event.attendees.length ? (
            <div className="flex items-start gap-1.5">
              <Users className="mt-0.5 size-4 shrink-0 text-faint" />
              <ul>
                {event.attendees.map((item) => (
                  <li key={item.address}>
                    {item.name || item.address}{" "}
                    <span className="text-xs text-faint">
                      {t(
                        {
                          ACCEPTED: "Acepta",
                          DECLINED: "Rechaza",
                          TENTATIVE: "Quizás",
                        }[item.status] ?? "Sin respuesta",
                      )}
                    </span>
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
    <Modal title={event ? t("Editar evento") : t("Nuevo evento")} onClose={onClose} keepOpen>
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
