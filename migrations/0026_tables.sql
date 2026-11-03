-- Data tables, phase 1: each .tabla file is a vault document supporting portfolios, sharing,
-- workspaces and trash. Columns and rows are keyed by owner and document. cells holds separate
-- column values so concurrent edits to different cells remain independent. See
-- src/server/table.ts and src/domain/vault/table.ts.
create table if not exists data_field (
  owner_id text not null,
  doc_id text not null,
  id text not null,
  name text not null,
  type text not null,
  options text not null default '{}',
  position double precision not null default 0,
  width integer,
  primary key (owner_id, doc_id, id)
);

create table if not exists data_row (
  owner_id text not null,
  doc_id text not null,
  id text not null,
  position double precision not null,
  cells jsonb not null default '{}'::jsonb,
  created_at bigint not null,
  updated_at bigint not null,
  updated_by text not null default '',
  -- Keep deleted rows temporarily so other clients observe deletion during synchronization.
  deleted boolean not null default false,
  primary key (owner_id, doc_id, id)
);

create index if not exists data_row_changes on data_row (owner_id, doc_id, updated_at);

-- Cell-derived links are merged with manual links without overwriting them; see syncTableLinks.
create table if not exists data_meta (
  owner_id text not null,
  doc_id text not null,
  derived_links text not null default '[]',
  primary key (owner_id, doc_id)
);
