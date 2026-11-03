-- SMTP settings in app_setting under mail_* keys, change notifications and initial account access
-- by email.

insert into app_permission (key, label, description, area, sort) values
  ('mail.manage', 'Correo electrónico', 'Configurar el servidor de correo (SMTP)', 'Administración', 76)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'mail.manage')
on conflict do nothing;

-- Account email preference for change notifications.
alter table app_profile add column if not exists notify_changes boolean not null default true;

-- Temporary passwords expire at expires_at, allow one sign-in tracked by used_at and require a
-- change. Delete the row after changing. note_id identifies the secret note to revoke when
-- resending; password_hash detects whether the temporary password was changed.
create table if not exists app_temp_access (
  user_id text primary key references "user" ("id") on delete cascade,
  expires_at bigint not null,
  used_at bigint,
  note_id text,
  password_hash text not null,
  created_at bigint not null
);

-- Secret notes for temporary passwords without Redis. Store only ciphertext; the decryption key
-- travels in the email link and is never stored here.
create table if not exists app_secret_note (
  id text primary key,
  sealed text not null,
  expires_at bigint not null
);

-- Pending change notifications, one per recipient and document. Batch delivery after the document
-- has been idle.
create table if not exists mail_notice (
  recipient_id text not null references "user" ("id") on delete cascade,
  owner_id text not null,
  doc_id text not null,
  actors text not null default '',
  first_at bigint not null,
  last_at bigint not null,
  primary key (recipient_id, owner_id, doc_id)
);
