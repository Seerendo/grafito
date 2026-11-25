import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { domainAllowed, historyDays, syncInterval, type MailPolicy } from "@/domain/mail/policy";
import { GmailConnector } from "./providers/gmail";
import { ImapConnector } from "./providers/imap";
import { MicrosoftConnector } from "./providers/microsoft";
import { MailError, type ConnectorAccount, type MailConnector } from "./providers/types";
import { enqueue } from "./queue";
import {
  openSecret,
  readMailPolicy,
  resolveImapTarget,
  sealSecret,
  type AccountSecret,
} from "./settings";

/**
 * Mail accounts: one person's connections. Every function takes the owner and filters by it, so
 * an id alone never reaches another person's account. The secret is sealed on the way in and
 * never comes back out to the browser.
 */

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

type Row = {
  id: string;
  user_id: string;
  provider: "imap" | "gmail" | "microsoft";
  email: string;
  display_name: string;
  username: string;
  host: string;
  port: number;
  tls: unknown;
  secret: string;
  is_default: unknown;
  sync_enabled: unknown;
  sync_interval_seconds: number;
  history_days: number;
  attachment_policy: string;
  mcp_access: unknown;
  status: string;
  status_detail: string;
  sync_phase: string;
  last_sync_at: unknown;
  next_sync_at: unknown;
  last_error: string;
  consecutive_failures: number;
  created_at: unknown;
};

/** What the browser sees of an account: no secret, only whether one is stored. */
export type AccountView = {
  id: string;
  provider: "imap" | "gmail" | "microsoft";
  email: string;
  name: string;
  username: string;
  host: string;
  port: number;
  isDefault: boolean;
  syncEnabled: boolean;
  intervalSeconds: number;
  historyDays: number;
  attachmentPolicy: "demand" | "small";
  mcpAccess: boolean;
  status: string;
  statusDetail: string;
  phase: string;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  lastError: string;
  failures: number;
  hasSecret: boolean;
};

function view(row: Row): AccountView {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    name: row.display_name || row.email,
    username: row.username,
    host: row.host,
    port: Number(row.port),
    isDefault: flag(row.is_default),
    syncEnabled: flag(row.sync_enabled),
    intervalSeconds: Number(row.sync_interval_seconds),
    historyDays: Number(row.history_days),
    attachmentPolicy: row.attachment_policy === "small" ? "small" : "demand",
    mcpAccess: flag(row.mcp_access),
    status: row.status,
    statusDetail: row.status_detail,
    phase: row.sync_phase,
    lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
    nextSyncAt: row.next_sync_at == null ? null : Number(row.next_sync_at),
    lastError: row.last_error,
    failures: Number(row.consecutive_failures),
    hasSecret: Boolean(row.secret),
  };
}

export async function listAccounts(sql: Sql, userId: string): Promise<AccountView[]> {
  const rows = await sql<Row>`
    select * from mail_account where user_id = ${userId} order by is_default desc, created_at
  `;
  return rows.map(view);
}

async function row(sql: Sql, userId: string, id: string): Promise<Row | null> {
  const rows =
    await sql<Row>`select * from mail_account where id = ${id} and user_id = ${userId} limit 1`;
  return rows[0] ?? null;
}

export async function getAccount(
  sql: Sql,
  userId: string,
  id: string,
): Promise<AccountView | null> {
  const found = await row(sql, userId, id);
  return found ? view(found) : null;
}

/** The connector's view of an account (secret opened). Worker and server use only. */
export async function connectorAccount(sql: Sql, id: string): Promise<ConnectorAccount | null> {
  const rows = await sql<Row>`select * from mail_account where id = ${id} limit 1`;
  const found = rows[0];
  if (!found) return null;
  return {
    id: found.id,
    userId: found.user_id,
    provider: found.provider,
    email: found.email,
    username: found.username,
    host: found.host,
    port: Number(found.port),
    tls: flag(found.tls),
    historyDays: Number(found.history_days),
    secret: openSecret(found.secret),
  };
}

export async function storeTokens(
  sql: Sql,
  accountId: string,
  secret: AccountSecret,
): Promise<void> {
  await sql`update mail_account set secret = ${sealSecret(secret)}, updated_at = ${Date.now()} where id = ${accountId}`;
}

/** A connector for the account, its IMAP host checked first. */
export async function buildConnector(sql: Sql, account: ConnectorAccount): Promise<MailConnector> {
  const save = async (secret: NonNullable<ConnectorAccount["secret"]>) =>
    storeTokens(sql, account.id, secret);
  if (account.provider === "gmail") return new GmailConnector(sql, account, save);
  if (account.provider === "microsoft") return new MicrosoftConnector(sql, account, save);
  const target = await resolveImapTarget(account.host, account.port);
  if (!target.ok) throw new MailError("permanent", target.error);
  return new ImapConnector(account, target.address);
}

export type ImapInput = {
  name: string;
  email: string;
  username: string;
  host: string;
  port: number;
  password: string;
  historyDays: number;
  intervalSeconds: number;
  attachmentPolicy: "demand" | "small";
};

async function checkNew(
  sql: Sql,
  userId: string,
  policy: MailPolicy,
  provider: "imap" | "gmail" | "microsoft",
  email: string,
) {
  if (!policy.providers.includes(provider))
    throw new MailError("permanent", "Ese proveedor no está disponible.");
  if (email && !domainAllowed(policy, email))
    throw new MailError("permanent", "Ese dominio de correo no está permitido.");
  const count = await sql<{
    n: number;
  }>`select count(*)::int as n from mail_account where user_id = ${userId}`;
  if ((count[0]?.n ?? 0) >= policy.maxAccountsPerUser)
    throw new MailError(
      "permanent",
      `Puedes tener como mucho ${policy.maxAccountsPerUser} cuentas.`,
    );
}

/**
 * Connect an IMAP account: the server is checked, the password is tried once with a
 * short timeout, and only then is anything stored and the first sync queued.
 */
export async function createImapAccount(
  sql: Sql,
  userId: string,
  input: ImapInput,
): Promise<AccountView> {
  const policy = await readMailPolicy(sql);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new MailError("permanent", "Escribe una dirección de correo válida.");
  await checkNew(sql, userId, policy, "imap", email);
  const host = input.host.trim().toLowerCase();
  const port = Number(input.port) || 993;
  if (!input.password) throw new MailError("permanent", "Escribe la contraseña.");
  const id = randomUUID();
  const account: ConnectorAccount = {
    id,
    userId,
    provider: "imap",
    email,
    username: input.username.trim(),
    host,
    port,
    tls: true,
    historyDays: historyDays(policy, input.historyDays),
    secret: { kind: "password", password: input.password },
  };
  const connector = await buildConnector(sql, account);
  try {
    await connector.test();
  } finally {
    await connector.close();
  }
  const now = Date.now();
  const first = (await listAccounts(sql, userId)).length === 0;
  await sql`
    insert into mail_account (id, user_id, provider, email, display_name, username, host, port, tls, secret,
      is_default, sync_interval_seconds, history_days, attachment_policy, status, next_sync_at, created_at, updated_at)
    values (${id}, ${userId}, 'imap', ${email}, ${input.name.trim().slice(0, 120)}, ${account.username}, ${host}, ${port},
      true, ${sealSecret({ kind: "password", password: input.password })}, ${first},
      ${syncInterval(policy, input.intervalSeconds)}, ${account.historyDays},
      ${input.attachmentPolicy === "small" ? "small" : "demand"}, 'connected', ${now}, ${now}, ${now})
  `;
  await enqueue(sql, { userId, accountId: id, kind: "sync", priority: 5 });
  const created = await getAccount(sql, userId, id);
  if (!created) throw new MailError("temporary", "No se pudo guardar la cuenta.");
  return created;
}

/** After an OAuth sign-in: a new account, or new tokens for an existing one. */
export async function saveOAuthAccount(
  sql: Sql,
  userId: string,
  input: {
    provider: "gmail" | "microsoft";
    email: string;
    accountId: string | null;
    secret: AccountSecret;
  },
): Promise<AccountView> {
  const policy = await readMailPolicy(sql);
  const now = Date.now();
  if (input.accountId) {
    const found = await row(sql, userId, input.accountId);
    if (!found || found.provider !== input.provider)
      throw new MailError("permanent", "Esa cuenta no existe.");
    await sql`
      update mail_account set secret = ${sealSecret(input.secret)}, status = 'connected', status_detail = '',
        last_error = '', consecutive_failures = 0, sync_enabled = true, next_sync_at = ${now}, updated_at = ${now}
      where id = ${found.id} and user_id = ${userId}
    `;
    await enqueue(sql, { userId, accountId: found.id, kind: "sync", priority: 5 });
    return view({ ...found, status: "connected" });
  }
  await checkNew(sql, userId, policy, input.provider, input.email);
  const existing = await sql<{ id: string }>`
    select id from mail_account where user_id = ${userId} and provider = ${input.provider} and email = ${input.email} limit 1
  `;
  if (existing[0]) return saveOAuthAccount(sql, userId, { ...input, accountId: existing[0].id });
  const id = randomUUID();
  const first = (await listAccounts(sql, userId)).length === 0;
  await sql`
    insert into mail_account (id, user_id, provider, email, display_name, secret, is_default, sync_interval_seconds,
      history_days, status, next_sync_at, created_at, updated_at)
    values (${id}, ${userId}, ${input.provider}, ${input.email}, ${input.email}, ${sealSecret(input.secret)}, ${first},
      ${policy.defaultIntervalSeconds}, ${Math.min(30, policy.maxHistoryDays)}, 'connected', ${now}, ${now}, ${now})
  `;
  await enqueue(sql, { userId, accountId: id, kind: "sync", priority: 5 });
  const created = await getAccount(sql, userId, id);
  if (!created) throw new MailError("temporary", "No se pudo guardar la cuenta.");
  return created;
}

export type AccountChanges = {
  name?: string;
  isDefault?: boolean;
  syncEnabled?: boolean;
  intervalSeconds?: number;
  historyDays?: number;
  attachmentPolicy?: "demand" | "small";
  mcpAccess?: boolean;
  password?: string;
};

export async function updateAccount(
  sql: Sql,
  userId: string,
  id: string,
  changes: AccountChanges,
): Promise<AccountView> {
  const found = await row(sql, userId, id);
  if (!found) throw new MailError("permanent", "Esa cuenta no existe.");
  const policy = await readMailPolicy(sql);
  const now = Date.now();
  if (changes.password !== undefined) {
    if (found.provider !== "imap")
      throw new MailError("permanent", "Esta cuenta se autoriza con su proveedor.");
    const account = await connectorAccount(sql, id);
    if (!account) throw new MailError("permanent", "Esa cuenta no existe.");
    account.secret = { kind: "password", password: changes.password };
    const connector = await buildConnector(sql, account);
    try {
      await connector.test();
    } finally {
      await connector.close();
    }
    await sql`
      update mail_account set secret = ${sealSecret(account.secret)}, status = 'connected', status_detail = '',
        last_error = '', consecutive_failures = 0, next_sync_at = ${now}, updated_at = ${now}
      where id = ${id} and user_id = ${userId}
    `;
    await sql`update mail_job set run_after = ${now} where account_id = ${id} and state = 'queued'`;
    await enqueue(sql, { userId, accountId: id, kind: "sync", priority: 5 });
  }
  if (changes.isDefault)
    await sql`update mail_account set is_default = (id = ${id}) where user_id = ${userId}`;
  await sql`
    update mail_account set
      display_name = coalesce(${changes.name?.trim().slice(0, 120) ?? null}, display_name),
      sync_enabled = coalesce(${changes.syncEnabled ?? null}, sync_enabled),
      sync_interval_seconds = ${changes.intervalSeconds !== undefined ? syncInterval(policy, changes.intervalSeconds) : Number(found.sync_interval_seconds)},
      history_days = ${changes.historyDays !== undefined ? historyDays(policy, changes.historyDays) : Number(found.history_days)},
      attachment_policy = coalesce(${changes.attachmentPolicy ?? null}, attachment_policy),
      mcp_access = coalesce(${changes.mcpAccess ?? null}, mcp_access),
      status = case when ${changes.syncEnabled === false} then 'paused'
        when ${changes.syncEnabled === true} and status = 'paused' then 'connected' else status end,
      next_sync_at = case when ${changes.syncEnabled === true} then ${now} else next_sync_at end,
      updated_at = ${now}
    where id = ${id} and user_id = ${userId}
  `;
  const updated = await getAccount(sql, userId, id);
  if (!updated) throw new MailError("permanent", "Esa cuenta no existe.");
  return updated;
}

export async function setFolderSync(
  sql: Sql,
  userId: string,
  folderId: string,
  enabled: boolean,
): Promise<void> {
  await sql`update mail_folder set sync_enabled = ${enabled}, updated_at = ${Date.now()} where id = ${folderId} and user_id = ${userId}`;
}

export async function syncNow(sql: Sql, userId: string, id: string): Promise<void> {
  const found = await row(sql, userId, id);
  if (!found) throw new MailError("permanent", "Esa cuenta no existe.");
  if (!found.secret) throw new MailError("permanent", "La cuenta está desconectada.");
  await enqueue(sql, { userId, accountId: id, kind: "sync", priority: 10 });
}

/**
 * Disconnect: the credentials are forgotten and syncing stops. Messages stay readable here until
 * the person deletes the local copy; nothing changes on the mail server.
 */
export async function disconnectAccount(sql: Sql, userId: string, id: string): Promise<void> {
  const now = Date.now();
  await sql`
    update mail_account set secret = '', sync_enabled = false, status = 'disconnected', status_detail = '',
      next_sync_at = null, updated_at = ${now}
    where id = ${id} and user_id = ${userId}
  `;
  await sql`update mail_job set state = 'cancelled', finished_at = ${now} where account_id = ${id} and state = 'queued'`;
}

/** Delete the local copy (messages, attachments) in the background. Archived documents stay. */
export async function deleteLocalData(sql: Sql, userId: string, id: string): Promise<void> {
  const found = await row(sql, userId, id);
  if (!found) throw new MailError("permanent", "Esa cuenta no existe.");
  await disconnectAccount(sql, userId, id);
  await sql`update mail_account set status = 'deleting', updated_at = ${Date.now()} where id = ${id} and user_id = ${userId}`;
  await enqueue(sql, { userId, accountId: id, kind: "cleanup", priority: 1 });
}
