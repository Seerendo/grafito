-- Email module: each person connects their own mail accounts (IMAP, Gmail, Microsoft 365), which
-- the mail-sync worker copies here in the background. Mail is private to its owner: every table
-- carries user_id and every query filters by it. Nothing here touches the vault; archiving a
-- message or an attachment creates an independent document (mail_archive_reference only records
-- where it came from).

insert into app_permission (key, label, description, area, sort) values
  ('mailbox.use', 'Usar', 'Conectar sus cuentas de correo, leerlas y archivarlas', 'Correo', 70),
  ('mailbox.manage', 'Administrar', 'Políticas, perfiles y estado del correo (sin leer mensajes)', 'Correo', 71)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'mailbox.use'),
  ('admin', 'mailbox.manage'),
  ('miembro', 'mailbox.use')
on conflict do nothing;

-- The module is an extension: off until an administrator turns it on, which needs the worker.
insert into app_plugin (id, name, description, enabled, built_in) values
  ('correo', 'Correo electrónico', 'Cuentas de correo sincronizadas por el servicio mail-sync', false, true)
on conflict (id) do nothing;

-- Institutional servers (Zimbra, Exchange with IMAP…): users pick one instead of typing hosts.
-- A profile's host is allowed even when it is a private address.
create table if not exists mail_profile (
  id text primary key,
  name text not null,
  provider text not null default 'imap',
  host text not null,
  port integer not null default 993,
  tls boolean not null default true,
  -- Email domains that suggest this profile (comma separated).
  domains text not null default '',
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists mail_account (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  provider text not null check (provider in ('imap', 'gmail', 'microsoft')),
  email text not null,
  display_name text not null default '',
  username text not null default '',
  host text not null default '',
  port integer not null default 993,
  tls boolean not null default true,
  profile_id text references mail_profile(id) on delete set null,
  -- Password or OAuth tokens, sealed with GRAFITO_ENCRYPTION_KEY (server/crypto.ts). Never sent
  -- back to the browser.
  secret text not null default '',
  is_default boolean not null default false,
  sync_enabled boolean not null default true,
  sync_interval_seconds integer not null default 300,
  history_days integer not null default 30,
  -- 'demand' (default) or 'small' (fetch attachments under the policy size while syncing).
  attachment_policy text not null default 'demand',
  -- MCP clients may read this account only when its owner allows it.
  mcp_access boolean not null default false,
  -- connected, syncing, ok, auth_error, connection_error, expired, paused, retrying, disconnected
  status text not null default 'pending',
  status_detail text not null default '',
  -- Paused by an administrator (operational control).
  admin_paused boolean not null default false,
  sync_phase text not null default 'initial',
  last_sync_at bigint,
  next_sync_at bigint,
  last_error text not null default '',
  consecutive_failures integer not null default 0,
  -- Only one sync of an account runs at a time, whichever worker holds this lease.
  lease_owner text,
  lease_until bigint,
  -- A separate lease for on-demand attachment downloads, so opening one does not wait for a sync.
  fetch_lease_owner text,
  fetch_lease_until bigint,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists mail_account_user on mail_account (user_id);
create index if not exists mail_account_due on mail_account (next_sync_at) where sync_enabled;

create table if not exists mail_folder (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  -- IMAP path, Gmail label id or Graph folder id.
  remote_id text not null,
  name text not null,
  path text not null,
  parent_id text,
  -- inbox, sent, drafts, archive, junk, trash, all, flagged, or '' for a custom folder.
  special_use text not null default '',
  sync_enabled boolean not null default true,
  removed boolean not null default false,
  message_count integer not null default 0,
  unread_count integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null,
  unique (account_id, remote_id)
);

create index if not exists mail_folder_user on mail_folder (user_id, account_id);

-- Where each folder (or, for Gmail, the account) stands: confirmed only after what it covers is
-- stored, so a restart resumes from the last confirmed point.
create table if not exists mail_sync_state (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  folder_id text references mail_folder(id) on delete cascade,
  uid_validity bigint,
  last_uid bigint not null default 0,
  highest_modseq text,
  history_id text,
  delta_link text,
  -- Initial window: the oldest UID or date still to fetch, and whether it is done.
  backfill_done boolean not null default false,
  backfill_cursor text,
  reconciled_at bigint,
  status text not null default 'pending',
  last_success_at bigint,
  last_attempt_at bigint,
  consecutive_failures integer not null default 0,
  last_error text not null default ''
);

create unique index if not exists mail_sync_state_scope
  on mail_sync_state (account_id, coalesce(folder_id, ''));

create table if not exists mail_message (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  -- Provider identity: IMAP folder:uidvalidity:uid, Gmail message id, Graph message id.
  provider_message_id text not null,
  internet_message_id text not null default '',
  thread_id text not null default '',
  subject text not null default '',
  from_name text not null default '',
  from_address text not null default '',
  to_json text not null default '[]',
  cc_json text not null default '[]',
  bcc_json text not null default '[]',
  reply_to_json text not null default '[]',
  sent_at bigint,
  received_at bigint not null,
  snippet text not null default '',
  body_text text not null default '',
  body_html text not null default '',
  -- pending, ready, too_large, failed
  body_state text not null default 'pending',
  size integer not null default 0,
  has_attachments boolean not null default false,
  -- What the server says, and what the person changed here (null: follow the server).
  remote_seen boolean not null default false,
  remote_flagged boolean not null default false,
  local_seen boolean,
  local_flagged boolean,
  hidden boolean not null default false,
  search tsvector,
  created_at bigint not null,
  updated_at bigint not null,
  unique (account_id, provider_message_id)
);

create index if not exists mail_message_list on mail_message (user_id, received_at desc, id desc);
create index if not exists mail_message_account on mail_message (account_id, received_at desc, id desc);
create index if not exists mail_message_search on mail_message using gin (search);

create table if not exists mail_message_location (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  message_id text not null references mail_message(id) on delete cascade,
  folder_id text not null references mail_folder(id) on delete cascade,
  remote_uid bigint,
  uid_validity bigint,
  flags text not null default '',
  modseq text,
  deleted_at bigint,
  unique (folder_id, message_id)
);

create unique index if not exists mail_location_uid
  on mail_message_location (folder_id, uid_validity, remote_uid) where remote_uid is not null;
create index if not exists mail_location_folder
  on mail_message_location (folder_id, deleted_at, message_id);
create index if not exists mail_location_message on mail_message_location (message_id);

create table if not exists mail_attachment (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  message_id text not null references mail_message(id) on delete cascade,
  -- IMAP body part, Gmail attachment id or Graph attachment id.
  provider_attachment_id text not null,
  filename text not null default '',
  content_type text not null default 'application/octet-stream',
  size integer not null default 0,
  content_id text not null default '',
  disposition text not null default 'attachment',
  storage_key text,
  checksum text,
  -- none, queued, downloading, ready, failed, blocked, too_large
  download_status text not null default 'none',
  -- pending, clean, infected, error, off
  antivirus_status text not null default 'pending',
  error text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  unique (message_id, provider_attachment_id)
);

create index if not exists mail_attachment_message on mail_attachment (message_id);
create index if not exists mail_attachment_user on mail_attachment (user_id, download_status);

-- Archived copies are independent documents: deleting the message or the account keeps them.
create table if not exists mail_archive_reference (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text,
  message_id text references mail_message(id) on delete set null,
  attachment_id text references mail_attachment(id) on delete set null,
  document_owner_id text not null,
  document_id text not null,
  portfolio_id text,
  format text not null default 'file',
  internet_message_id text not null default '',
  archived_by text not null default '',
  archived_at bigint not null
);

create index if not exists mail_archive_user on mail_archive_reference (user_id, message_id);

-- Work for the mail-sync worker. A queued job with the same dedupe key is not added twice, so
-- retries and double clicks are idempotent; a running job holds a lease another worker takes
-- over once it expires.
create table if not exists mail_job (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  kind text not null,
  payload text not null default '{}',
  dedupe_key text not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed', 'cancelled')),
  priority integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  run_after bigint not null,
  lease_owner text,
  lease_until bigint,
  last_error text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  finished_at bigint,
  duration_ms integer
);

create unique index if not exists mail_job_pending
  on mail_job (dedupe_key) where state in ('queued', 'running');
create index if not exists mail_job_ready on mail_job (state, run_after, priority);
create index if not exists mail_job_account on mail_job (account_id, state);

-- Each running worker writes a heartbeat; the extension is connected while one is recent.
create table if not exists mail_worker (
  id text primary key,
  host text not null default '',
  started_at bigint not null,
  beat_at bigint not null,
  active_jobs integer not null default 0,
  stats text not null default '{}'
);

-- OAuth sign-ins in progress (state and PKCE verifier), valid for ten minutes.
create table if not exists mail_oauth_state (
  state text primary key,
  user_id text not null references "user"(id) on delete cascade,
  provider text not null,
  verifier text not null,
  account_id text,
  created_at bigint not null
);
