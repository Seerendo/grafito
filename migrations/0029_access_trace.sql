-- Caducidad, revocación y rastro de permisos y de enlaces públicos.
-- Un permiso vigente está en share_grant / share_org_grant (o el token del
-- enlace). Al revocarlo o al caducar pasa a access_grant_log, que conserva
-- desde cuándo valía y hasta cuándo. access_event anota las aperturas.

alter table share_grant add column if not exists granted_at bigint not null default 0;
alter table share_grant add column if not exists expires_at bigint;

alter table share_org_grant add column if not exists granted_at bigint not null default 0;
alter table share_org_grant add column if not exists expires_at bigint;

alter table share_item add column if not exists link_granted_at bigint;
alter table share_item add column if not exists link_expires_at bigint;
alter table share_item add column if not exists link_revoked_at bigint;

alter table data_form add column if not exists opened_at bigint;
alter table data_form add column if not exists expires_at bigint;
alter table data_form add column if not exists revoked_at bigint;

create table if not exists access_grant_log (
  id text primary key,
  owner_id text not null,
  scope text not null,
  scope_id text not null,
  subject_kind text not null,
  subject_id text not null default '',
  subject_name text not null default '',
  granted_at bigint not null,
  expires_at bigint,
  ended_at bigint not null,
  end_kind text not null,
  ended_by text not null default ''
);

create index if not exists access_grant_log_scope on access_grant_log (owner_id, scope, scope_id, ended_at desc);

create table if not exists access_event (
  id text primary key,
  owner_id text not null,
  share_id text not null default '',
  form_doc_id text not null default '',
  channel text not null,
  actor_id text not null default '',
  actor_name text not null default '',
  at bigint not null
);

create index if not exists access_event_share on access_event (owner_id, share_id, at desc);
create index if not exists access_event_form on access_event (owner_id, form_doc_id, at desc);
