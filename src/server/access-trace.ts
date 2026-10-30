import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";

/**
 * Caducidad, revocación y rastro (migración 0029). Lo vigente vive en el
 * permiso o en el token; al cerrarse queda en `access_grant_log`. Las
 * aperturas van a `access_event`, como mucho una por persona y hora.
 */

const HOUR = 60 * 60 * 1000;
const KEEP_EVENTS = 180 * 24 * HOUR;

export type GrantPeriod = {
  subjectKind: "user" | "org" | "link";
  subjectId: string;
  subjectName: string;
  grantedAt: number;
  expiresAt: number | null;
  endedAt: number | null;
  endKind: "" | "revoked" | "expired";
};

export type AccessHit = {
  at: number;
  channel: "grant" | "public" | "form";
  actorName: string;
};

type LogRow = {
  ownerId: string;
  scope: "share" | "form";
  scopeId: string;
  subjectKind: "user" | "org" | "link";
  subjectId: string;
  subjectName: string;
  grantedAt: number;
  expiresAt: number | null;
  endedAt: number;
  endKind: "revoked" | "expired";
  endedBy: string;
};

function millis(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export async function personName(sql: Sql, userId: string): Promise<string> {
  const rows = await sql<{ name: string }>`select name from "user" where id = ${userId} limit 1`;
  return rows[0]?.name?.trim() || "";
}

async function logPeriod(sql: Sql, row: LogRow): Promise<void> {
  await sql`
    insert into access_grant_log (
      id, owner_id, scope, scope_id, subject_kind, subject_id, subject_name,
      granted_at, expires_at, ended_at, end_kind, ended_by
    ) values (
      ${randomUUID()}, ${row.ownerId}, ${row.scope}, ${row.scopeId}, ${row.subjectKind}, ${row.subjectId},
      ${row.subjectName.slice(0, 200)}, ${row.grantedAt}, ${row.expiresAt}, ${row.endedAt}, ${row.endKind},
      ${row.endedBy.slice(0, 200)}
    )
  `;
}

/** Pasa a historial lo que ya caducó y lo quita del permiso vigente. */
export async function retireExpired(sql: Sql, now = Date.now()): Promise<void> {
  const users = await sql<{
    share_id: string;
    user_id: string;
    name: string;
    granted_at: unknown;
    expires_at: unknown;
    owner_id: string;
  }>`
    select g.share_id, g.user_id, u.name, g.granted_at, g.expires_at, s.owner_id
    from share_grant g
    join share_item s on s.id = g.share_id
    join "user" u on u.id = g.user_id
    where g.expires_at is not null and g.expires_at <= ${now}
  `;
  for (const row of users) {
    await logPeriod(sql, {
      ownerId: row.owner_id,
      scope: "share",
      scopeId: row.share_id,
      subjectKind: "user",
      subjectId: row.user_id,
      subjectName: row.name?.trim() || "",
      grantedAt: millis(row.granted_at) ?? 0,
      expiresAt: millis(row.expires_at),
      endedAt: millis(row.expires_at) ?? now,
      endKind: "expired",
      endedBy: "",
    });
    await sql`delete from share_grant where share_id = ${row.share_id} and user_id = ${row.user_id}`;
  }
  const orgs = await sql<{
    share_id: string;
    org_id: string;
    name: string;
    granted_at: unknown;
    expires_at: unknown;
    owner_id: string;
  }>`
    select g.share_id, g.org_id, o.name, g.granted_at, g.expires_at, s.owner_id
    from share_org_grant g
    join share_item s on s.id = g.share_id
    join app_org o on o.id = g.org_id
    where g.expires_at is not null and g.expires_at <= ${now}
  `;
  for (const row of orgs) {
    await logPeriod(sql, {
      ownerId: row.owner_id,
      scope: "share",
      scopeId: row.share_id,
      subjectKind: "org",
      subjectId: row.org_id,
      subjectName: row.name?.trim() || "",
      grantedAt: millis(row.granted_at) ?? 0,
      expiresAt: millis(row.expires_at),
      endedAt: millis(row.expires_at) ?? now,
      endKind: "expired",
      endedBy: "",
    });
    await sql`delete from share_org_grant where share_id = ${row.share_id} and org_id = ${row.org_id}`;
  }
  const links = await sql<{
    id: string;
    owner_id: string;
    title: string;
    link_granted_at: unknown;
    link_expires_at: unknown;
  }>`
    select id, owner_id, title, link_granted_at, link_expires_at from share_item
    where visibility = 'public' and public_token is not null and link_revoked_at is null
      and link_expires_at is not null and link_expires_at <= ${now}
  `;
  for (const row of links) {
    await logPeriod(sql, {
      ownerId: row.owner_id,
      scope: "share",
      scopeId: row.id,
      subjectKind: "link",
      subjectId: "",
      subjectName: row.title,
      grantedAt: millis(row.link_granted_at) ?? 0,
      expiresAt: millis(row.link_expires_at),
      endedAt: millis(row.link_expires_at) ?? now,
      endKind: "expired",
      endedBy: "",
    });
    await sql`
      update share_item set public_token = null, link_revoked_at = ${millis(row.link_expires_at) ?? now}
      where id = ${row.id}
    `;
  }
  const forms = await sql<{
    owner_id: string;
    doc_id: string;
    title: string;
    opened_at: unknown;
    expires_at: unknown;
  }>`
    select owner_id, doc_id, title, opened_at, expires_at from data_form
    where enabled and public_token is not null and revoked_at is null
      and expires_at is not null and expires_at <= ${now}
  `;
  for (const row of forms) {
    await logPeriod(sql, {
      ownerId: row.owner_id,
      scope: "form",
      scopeId: row.doc_id,
      subjectKind: "link",
      subjectId: "",
      subjectName: row.title,
      grantedAt: millis(row.opened_at) ?? 0,
      expiresAt: millis(row.expires_at),
      endedAt: millis(row.expires_at) ?? now,
      endKind: "expired",
      endedBy: "",
    });
    await sql`
      update data_form set enabled = false, public_token = null, revoked_at = ${millis(row.expires_at) ?? now}
      where owner_id = ${row.owner_id} and doc_id = ${row.doc_id}
    `;
  }
  await sql`delete from access_event where at < ${now - KEEP_EVENTS}`;
}

/** Anota una apertura. Si la misma persona ya entró en la última hora, no repite. */
export async function noteAccess(
  sql: Sql,
  input: {
    ownerId: string;
    shareId?: string;
    formDocId?: string;
    channel: AccessHit["channel"];
    actorId: string;
    actorName: string;
  },
): Promise<void> {
  const now = Date.now();
  const shareId = input.shareId ?? "";
  const formDocId = input.formDocId ?? "";
  const recent = await sql<{ id: string }>`
    select id from access_event
    where owner_id = ${input.ownerId} and share_id = ${shareId} and form_doc_id = ${formDocId}
      and channel = ${input.channel} and actor_id = ${input.actorId} and at > ${now - HOUR}
    limit 1
  `;
  if (recent[0]) return;
  let actorName = input.actorName;
  if (!actorName && input.actorId) actorName = await personName(sql, input.actorId);
  await sql`
    insert into access_event (id, owner_id, share_id, form_doc_id, channel, actor_id, actor_name, at)
    values (
      ${randomUUID()}, ${input.ownerId}, ${shareId}, ${formDocId}, ${input.channel},
      ${input.actorId}, ${(actorName || "Alguien").slice(0, 200)}, ${now}
    )
  `;
}

export async function endUserGrant(
  sql: Sql,
  input: { ownerId: string; shareId: string; userId: string; endedBy: string; endKind?: "revoked" | "expired" },
): Promise<boolean> {
  const rows = await sql<{ granted_at: unknown; expires_at: unknown; name: string }>`
    select g.granted_at, g.expires_at, u.name from share_grant g
    join "user" u on u.id = g.user_id
    where g.share_id = ${input.shareId} and g.user_id = ${input.userId} limit 1
  `;
  const row = rows[0];
  if (!row) return false;
  const now = Date.now();
  await logPeriod(sql, {
    ownerId: input.ownerId,
    scope: "share",
    scopeId: input.shareId,
    subjectKind: "user",
    subjectId: input.userId,
    subjectName: row.name?.trim() || "",
    grantedAt: millis(row.granted_at) ?? 0,
    expiresAt: millis(row.expires_at),
    endedAt: now,
    endKind: input.endKind ?? "revoked",
    endedBy: input.endedBy,
  });
  await sql`delete from share_grant where share_id = ${input.shareId} and user_id = ${input.userId}`;
  return true;
}

export async function endOrgGrant(
  sql: Sql,
  input: { ownerId: string; shareId: string; orgId: string; endedBy: string },
): Promise<boolean> {
  const rows = await sql<{ granted_at: unknown; expires_at: unknown; name: string }>`
    select g.granted_at, g.expires_at, o.name from share_org_grant g
    join app_org o on o.id = g.org_id
    where g.share_id = ${input.shareId} and g.org_id = ${input.orgId} limit 1
  `;
  const row = rows[0];
  if (!row) return false;
  const now = Date.now();
  await logPeriod(sql, {
    ownerId: input.ownerId,
    scope: "share",
    scopeId: input.shareId,
    subjectKind: "org",
    subjectId: input.orgId,
    subjectName: row.name?.trim() || "",
    grantedAt: millis(row.granted_at) ?? 0,
    expiresAt: millis(row.expires_at),
    endedAt: now,
    endKind: "revoked",
    endedBy: input.endedBy,
  });
  await sql`delete from share_org_grant where share_id = ${input.shareId} and org_id = ${input.orgId}`;
  return true;
}

export async function endPublicLink(
  sql: Sql,
  input: { ownerId: string; shareId: string; title: string; grantedAt: number | null; expiresAt: number | null; endedBy: string },
): Promise<void> {
  const now = Date.now();
  await logPeriod(sql, {
    ownerId: input.ownerId,
    scope: "share",
    scopeId: input.shareId,
    subjectKind: "link",
    subjectId: "",
    subjectName: input.title,
    grantedAt: input.grantedAt ?? 0,
    expiresAt: input.expiresAt,
    endedAt: now,
    endKind: "revoked",
    endedBy: input.endedBy,
  });
}

export async function endFormLink(
  sql: Sql,
  input: { ownerId: string; docId: string; title: string; grantedAt: number | null; expiresAt: number | null; endedBy: string },
): Promise<void> {
  const now = Date.now();
  await logPeriod(sql, {
    ownerId: input.ownerId,
    scope: "form",
    scopeId: input.docId,
    subjectKind: "link",
    subjectId: "",
    subjectName: input.title,
    grantedAt: input.grantedAt ?? 0,
    expiresAt: input.expiresAt,
    endedAt: now,
    endKind: "revoked",
    endedBy: input.endedBy,
  });
}

function periodFrom(row: {
  subject_kind: string;
  subject_id: string;
  subject_name: string;
  granted_at: unknown;
  expires_at: unknown;
  ended_at: unknown;
  end_kind: string;
}): GrantPeriod {
  const endKind = row.end_kind === "revoked" || row.end_kind === "expired" ? row.end_kind : "";
  return {
    subjectKind: row.subject_kind === "org" || row.subject_kind === "link" ? row.subject_kind : "user",
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    grantedAt: millis(row.granted_at) ?? 0,
    expiresAt: millis(row.expires_at),
    endedAt: millis(row.ended_at),
    endKind,
  };
}

export async function readTrail(
  sql: Sql,
  ownerId: string,
  scope: "share" | "form",
  scopeId: string,
): Promise<{ periods: GrantPeriod[]; events: AccessHit[] }> {
  const closed = await sql<{
    subject_kind: string;
    subject_id: string;
    subject_name: string;
    granted_at: unknown;
    expires_at: unknown;
    ended_at: unknown;
    end_kind: string;
  }>`
    select subject_kind, subject_id, subject_name, granted_at, expires_at, ended_at, end_kind
    from access_grant_log
    where owner_id = ${ownerId} and scope = ${scope} and scope_id = ${scopeId}
    order by ended_at desc limit 40
  `;
  const events =
    scope === "share"
      ? await sql<{ at: unknown; channel: string; actor_name: string }>`
          select at, channel, actor_name from access_event
          where owner_id = ${ownerId} and share_id = ${scopeId}
          order by at desc limit 40
        `
      : await sql<{ at: unknown; channel: string; actor_name: string }>`
          select at, channel, actor_name from access_event
          where owner_id = ${ownerId} and form_doc_id = ${scopeId}
          order by at desc limit 40
        `;
  return {
    periods: closed.map(periodFrom),
    events: events.map((row) => ({
      at: Number(row.at),
      channel: row.channel === "public" || row.channel === "form" ? row.channel : "grant",
      actorName: row.actor_name,
    })),
  };
}
