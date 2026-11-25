import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { htmlToText, snippetOf } from "@/domain/mail/message";
import type { MailPolicy } from "@/domain/mail/policy";
import type { RemoteFolder, RemoteMessage, SyncState } from "./providers/types";

/**
 * Persistence for one account's sync, used by the worker. Every write is an upsert keyed by the
 * provider's identity, so a batch stored twice (a retried job, two workers after a lease expired)
 * leaves one copy. Cursors are saved by the connector only after the batch they cover.
 */

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export type AccountScope = { id: string; userId: string };

export async function upsertFolders(
  sql: Sql,
  account: AccountScope,
  remote: RemoteFolder[],
): Promise<Map<string, { id: string; syncEnabled: boolean }>> {
  const now = Date.now();
  const existing = await sql<{ id: string; remote_id: string; sync_enabled: unknown }>`
    select id, remote_id, sync_enabled from mail_folder where account_id = ${account.id}
  `;
  const byRemote = new Map(existing.map((row) => [row.remote_id, row]));
  const map = new Map<string, { id: string; syncEnabled: boolean }>();
  for (const folder of remote) {
    const found = byRemote.get(folder.remoteId);
    const id = found?.id ?? randomUUID();
    // Spam and trash are listed but not synced unless the person turns them on.
    const defaultEnabled =
      folder.specialUse !== "junk" && folder.specialUse !== "trash" && folder.specialUse !== "all";
    await sql`
      insert into mail_folder (id, user_id, account_id, remote_id, name, path, parent_id, special_use,
        sync_enabled, removed, created_at, updated_at)
      values (${id}, ${account.userId}, ${account.id}, ${folder.remoteId}, ${folder.name.slice(0, 300)},
        ${folder.path.slice(0, 1000)}, ${folder.parentRemoteId}, ${folder.specialUse}, ${defaultEnabled}, false, ${now}, ${now})
      on conflict (account_id, remote_id) do update set name = excluded.name, path = excluded.path,
        parent_id = excluded.parent_id, special_use = excluded.special_use, removed = false, updated_at = excluded.updated_at
    `;
    map.set(folder.remoteId, {
      id,
      syncEnabled: found ? flag(found.sync_enabled) : defaultEnabled,
    });
  }
  // Folders gone from the server: their messages stop listing; archived documents stay.
  const present = new Set(remote.map((folder) => folder.remoteId));
  for (const row of existing) {
    if (present.has(row.remote_id)) continue;
    await sql`update mail_folder set removed = true, updated_at = ${now} where id = ${row.id}`;
    await sql`update mail_message_location set deleted_at = ${now} where folder_id = ${row.id} and deleted_at is null`;
  }
  return map;
}

const EMPTY: SyncState = {
  uidValidity: null,
  lastUid: 0,
  highestModseq: null,
  historyId: null,
  deltaLink: null,
  backfillDone: false,
  backfillCursor: null,
  reconciledAt: null,
};

export async function readState(
  sql: Sql,
  accountId: string,
  folderId: string | null,
): Promise<SyncState> {
  const rows = await sql<{
    uid_validity: unknown;
    last_uid: unknown;
    highest_modseq: string | null;
    history_id: string | null;
    delta_link: string | null;
    backfill_done: unknown;
    backfill_cursor: string | null;
    reconciled_at: unknown;
  }>`
    select uid_validity, last_uid, highest_modseq, history_id, delta_link, backfill_done, backfill_cursor, reconciled_at
    from mail_sync_state where account_id = ${accountId} and coalesce(folder_id, '') = ${folderId ?? ""} limit 1
  `;
  const row = rows[0];
  if (!row) return { ...EMPTY };
  return {
    uidValidity: row.uid_validity == null ? null : Number(row.uid_validity),
    lastUid: Number(row.last_uid ?? 0),
    highestModseq: row.highest_modseq,
    historyId: row.history_id,
    deltaLink: row.delta_link,
    backfillDone: flag(row.backfill_done),
    backfillCursor: row.backfill_cursor,
    reconciledAt: row.reconciled_at == null ? null : Number(row.reconciled_at),
  };
}

export async function writeState(
  sql: Sql,
  account: AccountScope,
  folderId: string | null,
  patch: Partial<SyncState>,
): Promise<void> {
  const next = { ...(await readState(sql, account.id, folderId)), ...patch };
  const now = Date.now();
  await sql`
    insert into mail_sync_state (id, user_id, account_id, folder_id, uid_validity, last_uid, highest_modseq,
      history_id, delta_link, backfill_done, backfill_cursor, reconciled_at, status, last_success_at, last_attempt_at)
    values (${randomUUID()}, ${account.userId}, ${account.id}, ${folderId}, ${next.uidValidity}, ${next.lastUid},
      ${next.highestModseq}, ${next.historyId}, ${next.deltaLink}, ${next.backfillDone}, ${next.backfillCursor},
      ${next.reconciledAt}, 'ok', ${now}, ${now})
    on conflict (account_id, coalesce(folder_id, '')) do update set uid_validity = excluded.uid_validity,
      last_uid = excluded.last_uid, highest_modseq = excluded.highest_modseq, history_id = excluded.history_id,
      delta_link = excluded.delta_link, backfill_done = excluded.backfill_done,
      backfill_cursor = excluded.backfill_cursor, reconciled_at = excluded.reconciled_at,
      status = 'ok', last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at,
      consecutive_failures = 0, last_error = ''
  `;
}

/** A changed UIDVALIDITY: every stored location of the folder is gone, and its cursor starts over. */
export async function resetFolder(sql: Sql, folderId: string): Promise<void> {
  const now = Date.now();
  await sql`update mail_message_location set deleted_at = ${now} where folder_id = ${folderId} and deleted_at is null`;
  await sql`delete from mail_sync_state where folder_id = ${folderId}`;
}

/** Text for the search index: subject and addresses always, the body when the policy allows. */
function searchText(message: RemoteMessage, text: string, policy: MailPolicy): string {
  const people = [message.from, ...message.to, ...message.cc]
    .map((item) => `${item.name} ${item.address}`)
    .join(" ");
  const names = message.attachments.map((item) => item.filename).join(" ");
  const body = policy.indexBodies ? text.slice(0, 20_000) : "";
  return `${message.subject} ${people} ${names} ${body}`.slice(0, 60_000);
}

export async function saveMessages(
  sql: Sql,
  account: AccountScope,
  folders: Map<string, string>,
  messages: RemoteMessage[],
  policy: MailPolicy,
): Promise<number> {
  const now = Date.now();
  let saved = 0;
  for (const message of messages) {
    const text = message.text || (message.html ? htmlToText(message.html) : "");
    const snippet = snippetOf(text);
    const rows = await sql<{ id: string }>`
      insert into mail_message (id, user_id, account_id, provider_message_id, internet_message_id, thread_id, subject,
        from_name, from_address, to_json, cc_json, bcc_json, reply_to_json, sent_at, received_at, snippet,
        body_text, body_html, body_state, size, has_attachments, remote_seen, remote_flagged, search, created_at, updated_at)
      values (${randomUUID()}, ${account.userId}, ${account.id}, ${message.providerMessageId}, ${message.internetMessageId},
        ${message.threadId}, ${message.subject}, ${message.from.name.slice(0, 300)}, ${message.from.address.slice(0, 300)},
        ${JSON.stringify(message.to)}, ${JSON.stringify(message.cc)}, ${JSON.stringify(message.bcc)},
        ${JSON.stringify(message.replyTo)}, ${message.sentAt}, ${message.receivedAt}, ${snippet},
        ${message.text}, ${message.html}, ${message.bodyState}, ${message.size},
        ${message.attachments.some((item) => item.disposition === "attachment")}, ${message.seen}, ${message.flagged},
        to_tsvector('simple', ${searchText(message, text, policy)}), ${now}, ${now})
      on conflict (account_id, provider_message_id) do update set subject = excluded.subject,
        remote_seen = excluded.remote_seen, remote_flagged = excluded.remote_flagged,
        thread_id = excluded.thread_id, updated_at = excluded.updated_at,
        body_text = case when mail_message.body_state = 'ready' then mail_message.body_text else excluded.body_text end,
        body_html = case when mail_message.body_state = 'ready' then mail_message.body_html else excluded.body_html end,
        body_state = case when mail_message.body_state = 'ready' then mail_message.body_state else excluded.body_state end
      returning id
    `;
    const messageId = rows[0]?.id;
    if (!messageId) continue;
    const kept: string[] = [];
    for (const location of message.locations) {
      const folderId = folders.get(location.folderRemoteId);
      if (!folderId) continue;
      kept.push(folderId);
      await sql`
        insert into mail_message_location (id, user_id, account_id, message_id, folder_id, remote_uid, uid_validity, flags, modseq)
        values (${randomUUID()}, ${account.userId}, ${account.id}, ${messageId}, ${folderId}, ${location.uid},
          ${location.uidValidity}, ${location.flags.join(" ")}, ${location.modseq})
        on conflict (folder_id, message_id) do update set remote_uid = excluded.remote_uid,
          uid_validity = excluded.uid_validity, flags = excluded.flags, modseq = excluded.modseq, deleted_at = null
      `;
    }
    // A label removed in Gmail, or a message moved in Graph: those locations are gone.
    if (kept.length)
      await sql`
        update mail_message_location set deleted_at = ${now}
        where message_id = ${messageId} and deleted_at is null
          and not (folder_id = any(string_to_array(${kept.join(",")}, ',')))
      `;
    for (const attachment of message.attachments) {
      await sql`
        insert into mail_attachment (id, user_id, account_id, message_id, provider_attachment_id, filename,
          content_type, size, content_id, disposition, created_at, updated_at)
        values (${randomUUID()}, ${account.userId}, ${account.id}, ${messageId}, ${attachment.providerAttachmentId},
          ${attachment.filename.slice(0, 300)}, ${attachment.contentType.slice(0, 200)}, ${attachment.size},
          ${attachment.contentId.slice(0, 300)}, ${attachment.disposition}, ${now}, ${now})
        on conflict (message_id, provider_attachment_id) do nothing
      `;
    }
    saved += 1;
  }
  await rememberContacts(
    sql,
    account.userId,
    messages.flatMap((message) => [message.from, ...message.to, ...message.cc]),
    now,
  );
  return saved;
}

/**
 * People seen in mail (senders and recipients), for suggestions while writing: one upsert per
 * batch, the most recent non-empty name kept.
 */
export async function rememberContacts(
  sql: Sql,
  userId: string,
  people: { name: string; address: string }[],
  at: number,
): Promise<void> {
  const merged = new Map<string, string>();
  for (const person of people) {
    const address = person.address.trim().toLowerCase();
    if (!address.includes("@") || address.length > 320) continue;
    const name = person.name.trim().slice(0, 200);
    if (!merged.has(address) || name) merged.set(address, name || merged.get(address) || "");
  }
  if (merged.size === 0) return;
  const items = JSON.stringify([...merged].map(([address, name]) => ({ address, name })));
  await sql`
    insert into mail_contact (user_id, address, name, uses, last_at)
    select ${userId}, item.address, item.name, 1, ${at}
    from jsonb_to_recordset(${items}::jsonb) as item(address text, name text)
    on conflict (user_id, address) do update set
      uses = mail_contact.uses + 1,
      name = case when excluded.name <> '' then excluded.name else mail_contact.name end,
      last_at = greatest(mail_contact.last_at, excluded.last_at)
  `;
}

/** Flags of messages already stored (CONDSTORE changes or a reconciliation). */
export async function updateFlags(
  sql: Sql,
  folderId: string,
  items: { uid: number; uidValidity: number; flags: string[]; modseq: string | null }[],
): Promise<void> {
  const now = Date.now();
  for (const item of items) {
    const rows = await sql<{ message_id: string }>`
      update mail_message_location set flags = ${item.flags.join(" ")}, modseq = coalesce(${item.modseq}, modseq)
      where folder_id = ${folderId} and uid_validity = ${item.uidValidity} and remote_uid = ${item.uid}
      returning message_id
    `;
    if (!rows[0]) continue;
    await sql`
      update mail_message set remote_seen = ${item.flags.includes("\\Seen")},
        remote_flagged = ${item.flags.includes("\\Flagged")}, updated_at = ${now}
      where id = ${rows[0].message_id}
        and (remote_seen <> ${item.flags.includes("\\Seen")} or remote_flagged <> ${item.flags.includes("\\Flagged")})
    `;
  }
}

export async function vanishUids(
  sql: Sql,
  folderId: string,
  uidValidity: number,
  uids: number[],
): Promise<void> {
  const now = Date.now();
  for (let index = 0; index < uids.length; index += 500) {
    const slice = uids.slice(index, index + 500).join(",");
    await sql`
      update mail_message_location set deleted_at = ${now}
      where folder_id = ${folderId} and uid_validity = ${uidValidity} and deleted_at is null
        and remote_uid = any(string_to_array(${slice}, ',')::bigint[])
    `;
  }
}

export async function vanishMessages(
  sql: Sql,
  accountId: string,
  folderId: string | null,
  providerIds: string[],
): Promise<void> {
  const now = Date.now();
  for (const id of providerIds) {
    const rows = await sql<{ id: string }>`
      select id from mail_message where account_id = ${accountId} and provider_message_id = ${id} limit 1
    `;
    if (!rows[0]) continue;
    if (folderId)
      await sql`update mail_message_location set deleted_at = ${now} where message_id = ${rows[0].id} and folder_id = ${folderId} and deleted_at is null`;
    else
      await sql`update mail_message_location set deleted_at = ${now} where message_id = ${rows[0].id} and deleted_at is null`;
  }
}

export async function localUids(
  sql: Sql,
  folderId: string,
  uidValidity: number,
): Promise<number[]> {
  const rows = await sql<{ remote_uid: unknown }>`
    select remote_uid from mail_message_location
    where folder_id = ${folderId} and uid_validity = ${uidValidity} and deleted_at is null and remote_uid is not null
  `;
  return rows.map((row) => Number(row.remote_uid));
}

/** Folder counters for the navigation, recomputed once per sync instead of per message. */
export async function refreshCounts(sql: Sql, accountId: string): Promise<void> {
  await sql`
    update mail_folder f set
      message_count = coalesce(c.total, 0),
      unread_count = coalesce(c.unread, 0)
    from (
      select f2.id,
        (select count(*) from mail_message_location l where l.folder_id = f2.id and l.deleted_at is null) as total,
        (select count(*) from mail_message_location l join mail_message m on m.id = l.message_id
          where l.folder_id = f2.id and l.deleted_at is null and not coalesce(m.local_seen, m.remote_seen)) as unread
      from mail_folder f2 where f2.account_id = ${accountId}
    ) c
    where f.id = c.id
  `;
}
