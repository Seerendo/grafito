import type { Sql } from "@/lib/db";
import { decodeCursor, encodeCursor, type MailAddress } from "@/domain/mail/message";

/**
 * What the mail screen reads: folders, a page of messages, one message and its attachments.
 * Every query starts from the signed-in person's user_id; a message, folder or attachment of
 * someone else is simply not found.
 */

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function addresses(raw: string): MailAddress[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as MailAddress[]).slice(0, 200) : [];
  } catch {
    return [];
  }
}

export type FolderView = {
  id: string;
  accountId: string;
  name: string;
  path: string;
  parentId: string | null;
  specialUse: string;
  syncEnabled: boolean;
  total: number;
  unread: number;
};

export async function listFolders(sql: Sql, userId: string): Promise<FolderView[]> {
  const rows = await sql<{
    id: string;
    account_id: string;
    name: string;
    path: string;
    parent_id: string | null;
    special_use: string;
    sync_enabled: unknown;
    message_count: number;
    unread_count: number;
  }>`
    select id, account_id, name, path, parent_id, special_use, sync_enabled, message_count, unread_count
    from mail_folder where user_id = ${userId} and not removed
    order by account_id, case special_use when 'inbox' then 0 when 'flagged' then 1 when 'sent' then 2
      when 'drafts' then 3 when 'archive' then 4 when 'junk' then 5 when 'trash' then 6 else 7 end, path
  `;
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    path: row.path,
    parentId: row.parent_id,
    specialUse: row.special_use,
    syncEnabled: flag(row.sync_enabled),
    total: Number(row.message_count),
    unread: Number(row.unread_count),
  }));
}

export type MessageFilter = {
  accountId?: string;
  folderId?: string;
  /** inbox, sent, drafts, archive, junk, trash: across every account (the unified views). */
  role?: string;
  /** Only flagged messages (Destacados). */
  flagged?: boolean;
  unread?: boolean;
  attachments?: boolean;
  from?: string;
  after?: number;
  before?: number;
  query?: string;
  cursor?: string | null;
  limit?: number;
};

export type MessageRow = {
  id: string;
  accountId: string;
  subject: string;
  from: MailAddress;
  snippet: string;
  receivedAt: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
};

const PAGE = 50;

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Words for a full-text query: each word must appear (prefix match on the last one). */
export function tsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{N}@._-]+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, " ").trim())
    .flatMap((word) => word.split(/\s+/))
    .filter(Boolean)
    .slice(0, 8);
  return words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word)).join(" & ");
}

/**
 * One page of messages, newest first, with a keyset cursor (never OFFSET): a person with a
 * hundred thousand messages pages as fast as one with ten. Messages without a live location
 * (deleted on the server, folder gone) are not listed.
 */
export async function listMessages(
  sql: Sql,
  userId: string,
  filter: MessageFilter,
): Promise<{ messages: MessageRow[]; next: string | null }> {
  const limit = Math.min(100, Math.max(1, filter.limit ?? PAGE));
  const cursor = decodeCursor(filter.cursor);
  const ts = filter.query ? tsQuery(filter.query) : "";
  const rows = await sql<{
    id: string;
    account_id: string;
    subject: string;
    from_name: string;
    from_address: string;
    snippet: string;
    received_at: unknown;
    seen: unknown;
    flagged: unknown;
    has_attachments: unknown;
  }>`
    select m.id, m.account_id, m.subject, m.from_name, m.from_address, m.snippet, m.received_at,
      coalesce(m.local_seen, m.remote_seen) as seen, coalesce(m.local_flagged, m.remote_flagged) as flagged,
      m.has_attachments
    from mail_message m
    where m.user_id = ${userId} and not m.hidden
      and (${filter.accountId ?? null}::text is null or m.account_id = ${filter.accountId ?? null})
      and exists (
        select 1 from mail_message_location l join mail_folder f on f.id = l.folder_id
        where l.message_id = m.id and l.deleted_at is null and f.user_id = ${userId}
          and (${filter.folderId ?? null}::text is null or f.id = ${filter.folderId ?? null})
          and (${filter.role ?? null}::text is null or f.special_use = ${filter.role ?? null})
      )
      and (${filter.flagged ?? false} = false or coalesce(m.local_flagged, m.remote_flagged))
      and (${filter.unread ?? false} = false or not coalesce(m.local_seen, m.remote_seen))
      and (${filter.attachments ?? false} = false or m.has_attachments)
      and (${filter.from ?? ""} = '' or m.from_address ilike ${likeTerm(filter.from ?? "")} or m.from_name ilike ${likeTerm(filter.from ?? "")})
      and (${filter.after ?? null}::bigint is null or m.received_at >= ${filter.after ?? null})
      and (${filter.before ?? null}::bigint is null or m.received_at < ${filter.before ?? null})
      and (${ts} = '' or m.search @@ to_tsquery('simple', ${ts || "x"}))
      and (${cursor?.at ?? null}::bigint is null
        or (m.received_at, m.id) < (${cursor?.at ?? 0}::bigint, ${cursor?.id ?? ""}))
    order by m.received_at desc, m.id desc
    limit ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    messages: page.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      subject: row.subject,
      from: { name: row.from_name, address: row.from_address },
      snippet: row.snippet,
      receivedAt: Number(row.received_at),
      seen: flag(row.seen),
      flagged: flag(row.flagged),
      hasAttachments: flag(row.has_attachments),
    })),
    next: rows.length > limit && last ? encodeCursor(Number(last.received_at), last.id) : null,
  };
}

export type AttachmentView = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string;
  inline: boolean;
  status: string;
  antivirus: string;
  error: string;
};

export type MessageDetail = MessageRow & {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  sentAt: number | null;
  internetMessageId: string;
  text: string;
  html: string;
  bodyState: string;
  account: { id: string; email: string; name: string; provider: string };
  folders: { id: string; name: string }[];
  attachments: AttachmentView[];
  archived: {
    documentId: string;
    ownerId: string;
    format: string;
    at: number;
    attachmentId: string | null;
  }[];
};

export async function listAttachments(
  sql: Sql,
  userId: string,
  messageId: string,
): Promise<AttachmentView[]> {
  const rows = await sql<{
    id: string;
    filename: string;
    content_type: string;
    size: number;
    content_id: string;
    disposition: string;
    download_status: string;
    antivirus_status: string;
    error: string;
  }>`
    select id, filename, content_type, size, content_id, disposition, download_status, antivirus_status, error
    from mail_attachment where message_id = ${messageId} and user_id = ${userId} order by created_at, id
  `;
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size),
    contentId: row.content_id,
    inline: row.disposition === "inline",
    status: row.download_status,
    antivirus: row.antivirus_status,
    error: row.error,
  }));
}

export async function getMessage(
  sql: Sql,
  userId: string,
  id: string,
): Promise<MessageDetail | null> {
  const rows = await sql<{
    id: string;
    account_id: string;
    subject: string;
    from_name: string;
    from_address: string;
    snippet: string;
    received_at: unknown;
    seen: unknown;
    flagged: unknown;
    has_attachments: unknown;
    to_json: string;
    cc_json: string;
    bcc_json: string;
    reply_to_json: string;
    sent_at: unknown;
    internet_message_id: string;
    body_text: string;
    body_html: string;
    body_state: string;
    email: string;
    display_name: string;
    provider: string;
  }>`
    select m.*, coalesce(m.local_seen, m.remote_seen) as seen, coalesce(m.local_flagged, m.remote_flagged) as flagged,
      a.email, a.display_name, a.provider
    from mail_message m join mail_account a on a.id = m.account_id
    where m.id = ${id} and m.user_id = ${userId} and a.user_id = ${userId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const folders = await sql<{ id: string; name: string }>`
    select f.id, f.name from mail_message_location l join mail_folder f on f.id = l.folder_id
    where l.message_id = ${id} and l.deleted_at is null and f.user_id = ${userId}
  `;
  const archived = await sql<{
    document_id: string;
    document_owner_id: string;
    format: string;
    archived_at: unknown;
    attachment_id: string | null;
  }>`
    select document_id, document_owner_id, format, archived_at, attachment_id from mail_archive_reference
    where user_id = ${userId} and message_id = ${id} order by archived_at desc
  `;
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject,
    from: { name: row.from_name, address: row.from_address },
    snippet: row.snippet,
    receivedAt: Number(row.received_at),
    seen: flag(row.seen),
    flagged: flag(row.flagged),
    hasAttachments: flag(row.has_attachments),
    to: addresses(row.to_json),
    cc: addresses(row.cc_json),
    bcc: addresses(row.bcc_json),
    replyTo: addresses(row.reply_to_json),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
    internetMessageId: row.internet_message_id,
    text: row.body_text,
    html: row.body_html,
    bodyState: row.body_state,
    account: {
      id: row.account_id,
      email: row.email,
      name: row.display_name || row.email,
      provider: row.provider,
    },
    folders,
    attachments: await listAttachments(sql, userId, id),
    archived: archived.map((item) => ({
      documentId: item.document_id,
      ownerId: item.document_owner_id,
      format: item.format,
      at: Number(item.archived_at),
      attachmentId: item.attachment_id,
    })),
  };
}

/** Local marks: read, flagged, hidden. They never change the mail server. */
export async function markMessage(
  sql: Sql,
  userId: string,
  id: string,
  changes: { seen?: boolean; flagged?: boolean; hidden?: boolean },
): Promise<boolean> {
  const rows = await sql<{ account_id: string }>`
    update mail_message set
      local_seen = coalesce(${changes.seen ?? null}, local_seen),
      local_flagged = coalesce(${changes.flagged ?? null}, local_flagged),
      hidden = coalesce(${changes.hidden ?? null}, hidden),
      updated_at = ${Date.now()}
    where id = ${id} and user_id = ${userId}
    returning account_id
  `;
  if (!rows[0]) return false;
  if (changes.seen !== undefined || changes.flagged !== undefined) {
    const { enqueue } = await import("./queue");
    await enqueue(sql, {
      userId,
      accountId: rows[0].account_id,
      kind: "flags",
      payload: { messageId: id },
      dedupe: `flags:${id}`,
      priority: 15,
    });
  }
  if (changes.seen !== undefined) {
    // Keep the unread counters right without recounting the whole account.
    await sql`
      update mail_folder f set unread_count = (
        select count(*) from mail_message_location l join mail_message m on m.id = l.message_id
        where l.folder_id = f.id and l.deleted_at is null and not coalesce(m.local_seen, m.remote_seen) and not m.hidden
      )
      where f.id in (select folder_id from mail_message_location where message_id = ${id})
    `;
  }
  return true;
}

/** Ask the worker for an attachment; returns its current state. */
export async function requestAttachment(
  sql: Sql,
  userId: string,
  attachmentId: string,
): Promise<{ status: string; accountId: string } | null> {
  const rows = await sql<{ download_status: string; account_id: string }>`
    select download_status, account_id from mail_attachment where id = ${attachmentId} and user_id = ${userId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (
    row.download_status === "ready" ||
    row.download_status === "blocked" ||
    row.download_status === "too_large"
  )
    return { status: row.download_status, accountId: row.account_id };
  if (row.download_status !== "queued" && row.download_status !== "downloading") {
    await sql`update mail_attachment set download_status = 'queued', error = '', updated_at = ${Date.now()} where id = ${attachmentId} and user_id = ${userId}`;
  }
  const { enqueue } = await import("./queue");
  await enqueue(sql, {
    userId,
    accountId: row.account_id,
    kind: "attachment",
    payload: { attachmentId },
    dedupe: `attachment:${attachmentId}`,
    priority: 20,
  });
  return { status: "queued", accountId: row.account_id };
}
