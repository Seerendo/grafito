import type { Sql } from "@/lib/db";
import type { Locale } from "@/domain/i18n";
import { changesMail, formMail, mailReady, readMailSettings, sendMail, shareMail } from "./mail";
import { purgeNotes } from "./secret-note";

/**
 * Avisos por correo de cambios (solo servidor). Ver docs/MAIL.md.
 *
 * Cuando alguien cambia un documento, se avisa a quienes tienen acceso a él
 * (su dueño y las personas u organizaciones con quienes se compartió, directa
 * o por un portafolio que lo contiene), menos a quien hizo el cambio. Lo
 * privado no avisa a nadie: solo lo cambia su dueño.
 *
 * Para no mandar un correo por cada autoguardado, el cambio queda pendiente en
 * `mail_notice` (uno por persona y documento) y se envía cuando el documento
 * lleva `QUIET_MS` sin cambios: un solo correo por persona con todo lo suyo.
 */

const QUIET_MS = 5 * 60_000;
const TICK_MS = 60_000;

/** Personas que pueden ver `docId` de `ownerId` a través de lo compartido (sin el dueño). */
async function sharedReaders(sql: Sql, ownerId: string, docId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }>`
    with recursive ancestors(id) as (
      select portfolio_id from vault_doc
      where user_id = ${ownerId} and id = ${docId} and portfolio_id is not null
      union
      select p.parent_id from vault_portfolio p
      join ancestors a on p.id = a.id
      where p.user_id = ${ownerId} and p.parent_id is not null
    ),
    items as (
      select id from share_item
      where owner_id = ${ownerId} and visibility = 'shared'
        and ((kind = 'document' and target_id = ${docId}) or (kind = 'portfolio' and target_id in (select id from ancestors)))
    ),
    orgs(id) as (
      select org_id from share_org_grant where share_id in (select id from items)
        and (expires_at is null or expires_at > ${Date.now()})
      union
      select o.id from app_org o join orgs g on o.parent_id = g.id
    )
    select user_id from share_grant where share_id in (select id from items)
      and (expires_at is null or expires_at > ${Date.now()})
    union
    select user_id from app_org_member where org_id in (select id from orgs)
  `;
  return rows.map((row) => row.user_id);
}

/**
 * Un documento cambió: deja el aviso pendiente para quienes tienen acceso.
 * No hace nada si el correo no está configurado o el documento es privado.
 */
export async function noteChange(
  sql: Sql,
  change: { ownerId: string; docId: string; actorId: string; actorName: string },
): Promise<void> {
  try {
    if (!mailReady(await readMailSettings(sql))) return;
    const readers = await sharedReaders(sql, change.ownerId, change.docId);
    if (readers.length === 0) return;
    const recipients = [...new Set([change.ownerId, ...readers])].filter((id) => id !== change.actorId);
    const now = Date.now();
    for (const recipient of recipients) {
      const pending = await sql<{ actors: string }>`
        select actors from mail_notice
        where recipient_id = ${recipient} and owner_id = ${change.ownerId} and doc_id = ${change.docId}
      `;
      const names = new Set((pending[0]?.actors ?? "").split("\n").filter(Boolean));
      names.add(change.actorName);
      const actors = [...names].join("\n");
      await sql`
        insert into mail_notice (recipient_id, owner_id, doc_id, actors, first_at, last_at)
        values (${recipient}, ${change.ownerId}, ${change.docId}, ${actors}, ${now}, ${now})
        on conflict (recipient_id, owner_id, doc_id) do update set last_at = excluded.last_at, actors = excluded.actors
      `;
    }
    startNotifier();
  } catch (error) {
    console.error("[notify]", error);
  }
}

/** Envía los avisos de los documentos que llevan un rato sin cambios. */
export async function flushNotices(sql: Sql): Promise<number> {
  const settings = await readMailSettings(sql);
  if (!mailReady(settings)) return 0;
  const ready = await sql<{ recipient_id: string }>`
    select distinct recipient_id from mail_notice n
    where not exists (
      select 1 from mail_notice m where m.recipient_id = n.recipient_id and m.last_at > ${Date.now() - QUIET_MS}
    )
  `;
  let sent = 0;
  for (const { recipient_id: recipient } of ready) {
    const notices = await sql<{ owner_id: string; doc_id: string; actors: string; title: string | null; deleted: unknown }>`
      delete from mail_notice n
      where n.recipient_id = ${recipient}
      returning n.owner_id, n.doc_id, n.actors,
        (select d.title from vault_doc d where d.user_id = n.owner_id and d.id = n.doc_id) as title,
        (select d.deleted from vault_doc d where d.user_id = n.owner_id and d.id = n.doc_id) as deleted
    `;
    const person = await sql<{ name: string; contact_email: string | null; locale: string | null; notify_changes: unknown }>`
      select u.name, p.contact_email, p.locale, p.notify_changes
      from "user" u left join app_profile p on p.user_id = u.id
      where u.id = ${recipient} limit 1
    `;
    const row = person[0];
    if (!row?.contact_email || row.notify_changes === false || row.notify_changes === "f") continue;
    // Solo lo que esta persona aún puede ver.
    const items: { title: string; actors: string[] }[] = [];
    for (const notice of notices) {
      if (!notice.title || notice.deleted === true || notice.deleted === "t") continue;
      if (notice.owner_id !== recipient && !(await sharedReaders(sql, notice.owner_id, notice.doc_id)).includes(recipient)) continue;
      items.push({ title: notice.title, actors: notice.actors.split("\n").filter(Boolean) });
    }
    if (items.length === 0) continue;
    const locale: Locale = row.locale === "en" ? "en" : "es";
    try {
      await sendMail(sql, changesMail(locale, { to: row.contact_email, name: row.name, url: settings.publicUrl, items }));
      sent += 1;
    } catch (error) {
      console.error("[notify]", error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

export type MailNoticeResult = { missing: string[]; mailed: number; failed: number; mailOff: boolean };

/** Miembros de una organización y de las que cuelgan de ella. */
async function orgMembers(sql: Sql, orgId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }>`
    with recursive orgs(id) as (
      select id from app_org where id = ${orgId}
      union
      select o.id from app_org o join orgs g on o.parent_id = g.id
    )
    select user_id from app_org_member where org_id in (select id from orgs)
  `;
  return rows.map((row) => row.user_id);
}

/**
 * Avisa por correo de un compartido o de una invitación a un formulario.
 * Solo a quien se acaba de añadir. Si el correo no está configurado, no falla:
 * quien llama dice que se guardó igual.
 */
export async function deliverNotice(
  sql: Sql,
  input: {
    actorId: string;
    actorName: string;
    title: string;
    path: string;
    userIds: string[];
    orgIds: string[];
    kind: "share" | "form";
  },
): Promise<MailNoticeResult> {
  const quiet = { missing: [] as string[], mailed: 0, failed: 0, mailOff: false };
  try {
    const settings = await readMailSettings(sql);
    if (!mailReady(settings)) return { ...quiet, mailOff: true };
    const ids = new Set(input.userIds.filter((id) => id && id !== input.actorId));
    for (const orgId of input.orgIds) {
      for (const member of await orgMembers(sql, orgId)) {
        if (member !== input.actorId) ids.add(member);
      }
    }
    const missing: string[] = [];
    let mailed = 0;
    let failed = 0;
    const url = `${settings.publicUrl.replace(/\/+$/, "")}${input.path}`;
    for (const userId of ids) {
      const person = await sql<{ name: string; contact_email: string | null; locale: string | null }>`
        select u.name, p.contact_email, p.locale
        from "user" u left join app_profile p on p.user_id = u.id
        where u.id = ${userId} limit 1
      `;
      const row = person[0];
      if (!row) continue;
      const name = row.name?.trim() || "Sin nombre";
      if (!row.contact_email?.trim()) {
        missing.push(name);
        continue;
      }
      const locale: Locale = row.locale === "en" ? "en" : "es";
      const mailInput = { to: row.contact_email.trim(), name, actor: input.actorName, title: input.title, url };
      try {
        await sendMail(sql, input.kind === "form" ? formMail(locale, mailInput) : shareMail(locale, mailInput));
        mailed += 1;
      } catch (error) {
        failed += 1;
        console.error("[notify]", error instanceof Error ? error.message : error);
      }
    }
    return { missing, mailed, failed, mailOff: false };
  } catch (error) {
    console.error("[notify]", error);
    return { ...quiet, failed: 1 };
  }
}

const globalRef = globalThis as typeof globalThis & { __grafitoNotifier__?: ReturnType<typeof setInterval> };

/** Arranca (una vez por proceso) el envío periódico de avisos. */
export function startNotifier(): void {
  if (globalRef.__grafitoNotifier__) return;
  globalRef.__grafitoNotifier__ = setInterval(() => {
    void (async () => {
      try {
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        await flushNotices(sql);
        await purgeNotes(sql);
      } catch (error) {
        console.error("[notify]", error);
      }
    })();
  }, TICK_MS);
  globalRef.__grafitoNotifier__.unref?.();
}
