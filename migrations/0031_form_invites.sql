-- User or organization form invitations are separate from public links. Keep their token stable
-- so emailed links continue working.

alter table data_form add column if not exists invite_token text;

create unique index if not exists data_form_invite_token on data_form (invite_token) where invite_token is not null;

create table if not exists data_form_invite (
  owner_id text not null,
  doc_id text not null,
  kind text not null,
  subject_id text not null,
  granted_at bigint not null,
  primary key (owner_id, doc_id, kind, subject_id)
);
