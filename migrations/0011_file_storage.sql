-- Archivos fuera de la fila de la nota: vault_doc guarda la clave del objeto
-- (MinIO / S3) y su tamaño. file_data queda solo para archivos antiguos hasta
-- que se migran (server/files.ts).
alter table vault_doc add column if not exists file_key text;
alter table vault_doc add column if not exists file_size bigint;

-- Si no hay almacenamiento de objetos configurado, los bytes van aquí.
create table if not exists file_blob (
  key text primary key,
  data bytea not null default ''::bytea,
  created_at timestamptz not null default now()
);
