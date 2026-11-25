import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";
import type { Sql } from "@/lib/db";
import { connectorAccount } from "./accounts";
import { MailError } from "./providers/types";
import { webRequest, type WebAnswer } from "./web";

/**
 * The calendar (Agenda) of mail accounts through CalDAV, as Zimbra, Nextcloud, Radicale, iCloud
 * and others serve it: the calendars are found from the account's web address
 * (/.well-known/caldav, or the address the person set), events are read for the range on screen
 * with their repetitions expanded, and created, changed or deleted on the server, which also
 * sends the invitations when it supports scheduling (Zimbra does). Nothing is copied into
 * Grafito: the server stays the only source.
 */

export type CalendarView = {
  id: string;
  accountId: string;
  accountEmail: string;
  name: string;
  color: string;
  writable: boolean;
  shown: boolean;
};

export type EventView = {
  /** calendar|href|occurrence */
  id: string;
  calendarId: string;
  href: string;
  etag: string;
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  /** For all-day events: the dates as written (YYYY-MM-DD), end exclusive. */
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  organizer: string;
  attendees: { name: string; address: string; status: string }[];
  recurring: boolean;
};

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

function list<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value)
    return String((value as { "#text": unknown })["#text"]);
  return "";
}

type Account = NonNullable<Awaited<ReturnType<typeof connectorAccount>>> & {
  webHost: string;
  caldavUrl: string;
};

async function account(sql: Sql, userId: string, accountId: string): Promise<Account> {
  const rows = await sql<{ user_id: string; web_host: string; caldav_url: string }>`
    select user_id, web_host, caldav_url from mail_account where id = ${accountId} limit 1
  `;
  if (!rows[0] || rows[0].user_id !== userId)
    throw new MailError("permanent", "Esa cuenta no existe.");
  const found = await connectorAccount(sql, accountId);
  if (!found) throw new MailError("permanent", "Esa cuenta no existe.");
  if (found.secret?.kind !== "password")
    throw new MailError("permanent", "La agenda necesita la contraseña de la cuenta.");
  return { ...found, webHost: rows[0].web_host, caldavUrl: rows[0].caldav_url };
}

function auth(found: Account) {
  return {
    user: found.username || found.email,
    pass: found.secret?.kind === "password" ? found.secret.password : "",
  };
}

async function dav(
  found: Account,
  url: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<WebAnswer> {
  const answer = await webRequest(url, {
    method,
    auth: auth(found),
    headers:
      body !== undefined
        ? { "content-type": "application/xml; charset=utf-8", ...headers }
        : headers,
    body,
  });
  if (answer.status === 401 || answer.status === 403)
    throw new MailError("auth", "El servidor de la agenda rechazó el usuario o la contraseña.");
  return answer;
}

type DavResponse = { href: string; props: Record<string, unknown>; status: string };

function multistatus(body: string): DavResponse[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch {
    throw new MailError("permanent", "El servidor de la agenda respondió algo que no es CalDAV.");
  }
  const root = (parsed as { multistatus?: { response?: unknown } })?.multistatus;
  return list(root?.response as Record<string, unknown> | Record<string, unknown>[]).map((item) => {
    const props: Record<string, unknown> = {};
    let status = "";
    for (const propstat of list(item.propstat as Record<string, unknown>[])) {
      const code = text(propstat.status);
      if (/ 200 /.test(code)) Object.assign(props, propstat.prop as object);
      else status ||= code;
    }
    return {
      href: text(list(item.href as unknown[])[0]),
      props,
      status: status || text(item.status),
    };
  });
}

function hrefOf(value: unknown): string {
  const inner = value && typeof value === "object" ? (value as { href?: unknown }).href : value;
  return text(list(inner as unknown[])[0]);
}

function baseUrl(found: Account): string {
  if (found.caldavUrl) return found.caldavUrl;
  return `https://${found.webHost || found.host}/.well-known/caldav`;
}

/** Find the account's calendars and remember them (which ones show is kept). */
export async function discoverCalendars(
  sql: Sql,
  userId: string,
  accountId: string,
): Promise<CalendarView[]> {
  const found = await account(sql, userId, accountId);
  const start = baseUrl(found);
  const principalAsk = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>`;
  const first = await dav(found, start, "PROPFIND", principalAsk, { depth: "0" });
  if (first.status !== 207)
    throw new MailError("permanent", "No se encontró una agenda CalDAV en ese servidor.");
  const top = multistatus(first.body)[0];
  let home = hrefOf(top?.props["calendar-home-set"]);
  const principal = hrefOf(top?.props["current-user-principal"]);
  if (!home && principal) {
    const second = await dav(
      found,
      new URL(principal, start).toString(),
      "PROPFIND",
      principalAsk,
      {
        depth: "0",
      },
    );
    home = hrefOf(multistatus(second.body)[0]?.props["calendar-home-set"]);
  }
  const homeUrl = new URL(home || principal || start, start).toString();
  const listing = await dav(
    found,
    homeUrl,
    "PROPFIND",
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>`,
    { depth: "1" },
  );
  if (listing.status !== 207)
    throw new MailError("permanent", "El servidor no mostró los calendarios.");
  const calendars = multistatus(listing.body).filter((item) => {
    const type = item.props.resourcetype as Record<string, unknown> | undefined;
    if (!type || !("calendar" in type)) return false;
    const components = JSON.stringify(item.props["supported-calendar-component-set"] ?? "");
    return (
      !components || components === '""' || /VEVENT/i.test(components) || !/name/.test(components)
    );
  });
  const now = Date.now();
  const kept: string[] = [];
  for (const item of calendars.slice(0, 30)) {
    const href = new URL(item.href, homeUrl).toString();
    const privileges = JSON.stringify(item.props["current-user-privilege-set"] ?? "");
    const writable = !privileges || privileges === '""' || /write|all/i.test(privileges);
    const id = randomUUID();
    await sql`
      insert into mail_calendar (id, user_id, account_id, href, name, color, writable, shown, updated_at)
      values (${id}, ${userId}, ${accountId}, ${href}, ${text(item.props.displayname).slice(0, 200) || "Calendario"},
        ${text(item.props["calendar-color"]).slice(0, 9)}, ${writable}, true, ${now})
      on conflict (account_id, href) do update set name = excluded.name, color = excluded.color,
        writable = excluded.writable, updated_at = excluded.updated_at
    `;
    kept.push(href);
  }
  await sql`
    delete from mail_calendar where account_id = ${accountId}
      and not (href = any(string_to_array(${kept.join("\n")}, E'\\n')))
  `;
  return listCalendars(sql, userId);
}

export async function listCalendars(sql: Sql, userId: string): Promise<CalendarView[]> {
  const rows = await sql<{
    id: string;
    account_id: string;
    email: string;
    name: string;
    color: string;
    writable: unknown;
    shown: unknown;
  }>`
    select c.id, c.account_id, a.email, c.name, c.color, c.writable, c.shown
    from mail_calendar c join mail_account a on a.id = c.account_id
    where c.user_id = ${userId} and a.secret <> ''
    order by a.is_default desc, a.created_at, c.name
  `;
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    accountEmail: row.email,
    name: row.name,
    color: row.color,
    writable: row.writable === true || row.writable === "t",
    shown: row.shown === true || row.shown === "t",
  }));
}

export async function showCalendar(
  sql: Sql,
  userId: string,
  id: string,
  shown: boolean,
): Promise<void> {
  await sql`update mail_calendar set shown = ${shown} where id = ${id} and user_id = ${userId}`;
}

async function calendarRow(sql: Sql, userId: string, id: string) {
  const rows = await sql<{ account_id: string; href: string; writable: unknown }>`
    select account_id, href, writable from mail_calendar where id = ${id} and user_id = ${userId} limit 1
  `;
  if (!rows[0]) throw new MailError("permanent", "Ese calendario no existe.");
  return rows[0];
}

/** Whether an event's address is inside the calendar's collection. */
function inside(href: string, calendar: string): boolean {
  try {
    const item = new URL(href);
    const base = new URL(calendar.endsWith("/") ? calendar : `${calendar}/`);
    return (
      item.origin === base.origin &&
      item.pathname.startsWith(base.pathname) &&
      !item.pathname.includes("/../")
    );
  } catch {
    return false;
  }
}

function stamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function address(value: string): string {
  return value
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
}

function dateText(time: ICAL.Time): string {
  return `${String(time.year).padStart(4, "0")}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

/** Events of the shown calendars between from and to, repetitions expanded. */
export async function listEvents(
  sql: Sql,
  userId: string,
  from: number,
  to: number,
): Promise<{ events: EventView[]; problems: string[] }> {
  const calendars = (await listCalendars(sql, userId)).filter((item) => item.shown);
  const events: EventView[] = [];
  const problems: string[] = [];
  const accounts = new Map<string, Account>();
  await Promise.all(
    calendars.map(async (calendar) => {
      try {
        let found = accounts.get(calendar.accountId);
        if (!found) {
          found = await account(sql, userId, calendar.accountId);
          accounts.set(calendar.accountId, found);
        }
        const row = await calendarRow(sql, userId, calendar.id);
        const answer = await dav(
          found,
          row.href,
          "REPORT",
          `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
          { depth: "1" },
        );
        if (answer.status !== 207) throw new MailError("temporary", `Respondió ${answer.status}.`);
        for (const item of multistatus(answer.body)) {
          const data = text(item.props["calendar-data"]);
          if (!data) continue;
          const href = new URL(item.href, row.href).toString();
          events.push(...expand(data, calendar.id, href, text(item.props.getetag), from, to));
        }
      } catch (error) {
        problems.push(
          `${calendar.name}: ${error instanceof MailError ? error.message : "no se pudo leer"}`,
        );
      }
    }),
  );
  events.sort((a, b) => a.start - b.start);
  return { events: events.slice(0, 2000), problems };
}

function expand(
  data: string,
  calendarId: string,
  href: string,
  etag: string,
  from: number,
  to: number,
): EventView[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(data));
  } catch {
    return [];
  }
  for (const zone of root.getAllSubcomponents("vtimezone"))
    ICAL.TimezoneService.register(new ICAL.Timezone(zone));
  const components = root.getAllSubcomponents("vevent");
  const master = components.find((item) => !item.hasProperty("recurrence-id")) ?? components[0];
  if (!master) return [];
  const event = new ICAL.Event(master);
  for (const exception of components)
    if (exception !== master && exception.hasProperty("recurrence-id"))
      event.relateException(exception);
  const view = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, key: string): EventView => ({
    id: `${calendarId}|${href}|${key}`,
    calendarId,
    href,
    etag,
    uid: item.uid ?? "",
    title: (item.summary ?? "").slice(0, 500),
    start: start.toJSDate().getTime(),
    end: end.toJSDate().getTime(),
    allDay: start.isDate,
    startDate: start.isDate ? dateText(start) : "",
    endDate: start.isDate ? dateText(end) : "",
    location: (item.location ?? "").slice(0, 500),
    description: (item.description ?? "").slice(0, 20_000),
    organizer: address(String(item.organizer ?? "")),
    attendees: item.attendees.slice(0, 200).map((attendee) => ({
      name: String(attendee.getParameter("cn") ?? ""),
      address: address(String(attendee.getFirstValue() ?? "")),
      status: String(attendee.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase(),
    })),
    recurring: event.isRecurring(),
  });
  if (!event.isRecurring()) {
    const end = event.endDate ?? event.startDate;
    return [view(event, event.startDate, end, "")];
  }
  const out: EventView[] = [];
  const iterator = event.iterator();
  for (
    let count = 0, next = iterator.next();
    next && count < 1000;
    next = iterator.next(), count += 1
  ) {
    if (next.toJSDate().getTime() >= to) break;
    const details = event.getOccurrenceDetails(next);
    if (
      details.endDate.toJSDate().getTime() <= from &&
      details.startDate.toJSDate().getTime() < from
    )
      continue;
    out.push(view(details.item, details.startDate, details.endDate, next.toString()));
  }
  return out;
}

export type EventInput = {
  calendarId: string;
  /** An existing event (not repeating): its href and etag. */
  href: string | null;
  etag: string | null;
  title: string;
  allDay: boolean;
  start: number;
  end: number;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  attendees: string[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Create or change an event; the server sends invitations when it handles scheduling. */
export async function saveEvent(sql: Sql, userId: string, input: EventInput): Promise<void> {
  const row = await calendarRow(sql, userId, input.calendarId);
  if (!(row.writable === true || row.writable === "t"))
    throw new MailError("permanent", "Ese calendario es de solo lectura.");
  const found = await account(sql, userId, row.account_id);
  if (!input.title.trim()) throw new MailError("permanent", "Escribe un título.");
  if (
    input.allDay
      ? !DATE.test(input.startDate) || !DATE.test(input.endDate)
      : !(input.end > input.start)
  )
    throw new MailError("permanent", "Revisa las fechas del evento.");
  let root: ICAL.Component;
  let vevent: ICAL.Component;
  let href = input.href;
  if (href) {
    if (!inside(href, row.href))
      throw new MailError("permanent", "Ese evento no es de este calendario.");
    const current = await webRequest(href, { method: "GET", auth: auth(found) });
    if (current.status !== 200)
      throw new MailError("permanent", "Ese evento ya no está en el servidor.");
    root = new ICAL.Component(ICAL.parse(current.body));
    const all = root.getAllSubcomponents("vevent");
    if (all.length !== 1 || all[0]!.hasProperty("rrule"))
      throw new MailError(
        "permanent",
        "Los eventos que se repiten se cambian en el servidor de correo.",
      );
    vevent = all[0]!;
  } else {
    root = new ICAL.Component(["vcalendar", [], []]);
    root.updatePropertyWithValue("prodid", "-//Grafito//Agenda//ES");
    root.updatePropertyWithValue("version", "2.0");
    vevent = new ICAL.Component("vevent");
    vevent.updatePropertyWithValue("uid", `${randomUUID()}@grafito`);
    root.addSubcomponent(vevent);
    href = new URL(
      `${randomUUID()}.ics`,
      row.href.endsWith("/") ? row.href : `${row.href}/`,
    ).toString();
  }
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  vevent.updatePropertyWithValue("summary", input.title.trim().slice(0, 500));
  for (const name of ["dtstart", "dtend", "duration", "location", "description"])
    vevent.removeAllProperties(name);
  if (input.allDay) {
    vevent.addPropertyWithValue("dtstart", ICAL.Time.fromDateString(input.startDate));
    vevent.addPropertyWithValue("dtend", ICAL.Time.fromDateString(input.endDate));
  } else {
    vevent.addPropertyWithValue("dtstart", ICAL.Time.fromJSDate(new Date(input.start), true));
    vevent.addPropertyWithValue("dtend", ICAL.Time.fromJSDate(new Date(input.end), true));
  }
  if (input.location.trim())
    vevent.addPropertyWithValue("location", input.location.trim().slice(0, 500));
  if (input.description.trim())
    vevent.addPropertyWithValue("description", input.description.slice(0, 20_000));
  const invited = [
    ...new Set(input.attendees.map((item) => item.trim().toLowerCase()).filter(Boolean)),
  ];
  for (const item of invited)
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item))
      throw new MailError("permanent", `«${item}» no es una dirección válida.`);
  const previous = new Map(
    vevent
      .getAllProperties("attendee")
      .map((prop) => [address(String(prop.getFirstValue())), prop]),
  );
  vevent.removeAllProperties("attendee");
  if (invited.length) {
    if (!vevent.hasProperty("organizer")) {
      const organizer = vevent.addPropertyWithValue("organizer", `mailto:${found.email}`);
      organizer.setParameter("cn", found.email);
    }
    for (const item of invited) {
      const kept = previous.get(item);
      if (kept) {
        vevent.addProperty(kept);
        continue;
      }
      const prop = vevent.addPropertyWithValue("attendee", `mailto:${item}`);
      prop.setParameter("role", "REQ-PARTICIPANT");
      prop.setParameter("partstat", "NEEDS-ACTION");
      prop.setParameter("rsvp", "TRUE");
    }
  }
  const sequence = Number(vevent.getFirstPropertyValue("sequence") ?? 0);
  vevent.updatePropertyWithValue("sequence", input.href ? sequence + 1 : 0);
  const answer = await webRequest(href, {
    method: "PUT",
    auth: auth(found),
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      ...(input.href && input.etag ? { "if-match": input.etag } : { "if-none-match": "*" }),
    },
    body: root.toString(),
  });
  if (answer.status === 412)
    throw new MailError("permanent", "El evento cambió en el servidor; vuelve a abrirlo.");
  if (answer.status < 200 || answer.status >= 300)
    throw new MailError("temporary", `El servidor de la agenda respondió ${answer.status}.`);
}

export async function deleteEvent(
  sql: Sql,
  userId: string,
  input: { calendarId: string; href: string; etag: string },
): Promise<void> {
  const row = await calendarRow(sql, userId, input.calendarId);
  if (!inside(input.href, row.href))
    throw new MailError("permanent", "Ese evento no es de este calendario.");
  const found = await account(sql, userId, row.account_id);
  const answer = await webRequest(input.href, {
    method: "DELETE",
    auth: auth(found),
    headers: input.etag ? { "if-match": input.etag } : {},
  });
  if (answer.status === 412)
    throw new MailError("permanent", "El evento cambió en el servidor; vuelve a abrirlo.");
  if (answer.status !== 404 && (answer.status < 200 || answer.status >= 300))
    throw new MailError("temporary", `El servidor de la agenda respondió ${answer.status}.`);
}
