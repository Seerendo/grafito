-- File bytes move out of note rows: vault_doc stores the MinIO/S3 object key and size. file_data
-- remains for legacy files until migrated by server/files.ts.
alter table vault_doc add column if not exists file_key text;
alter table vault_doc add column if not exists file_size bigint;

-- Store bytes here when object storage is not configured.
create table if not exists file_blob (
  key text primary key,
  data bytea not null default ''::bytea,
  created_at timestamptz not null default now()
);
