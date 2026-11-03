-- Data tables, phase 2: index cell text for UI, Elasticsearch and AI search. Each table has one
-- form defining requested columns and an optional public token allowing row creation without
-- reading existing rows.

alter table data_meta add column if not exists search_text text not null default '';

create table if not exists data_form (
  owner_id text not null,
  doc_id text not null,
  title text not null,
  description text not null default '',
  fields text not null default '[]',
  public_token text,
  enabled boolean not null default false,
  primary key (owner_id, doc_id)
);

create unique index if not exists data_form_token on data_form (public_token) where public_token is not null;
