-- Tablas de datos (fase 1): la tabla es un documento de la bóveda (un archivo
-- `.tabla`, ver `src/domain/vault/table.ts`), así que vive en portafolios, se
-- comparte, entra en espacios de trabajo y va a la papelera como cualquier
-- otro. Sus columnas y filas viven aquí, por dueño y documento. Cada celda se
-- guarda por separado (`cells` es un objeto por columna), así que dos personas
-- pueden cambiar celdas distintas a la vez. Ver `src/server/table.ts`.
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
  -- Borrada: se guarda un momento para que los demás se enteren al pedir cambios.
  deleted boolean not null default false,
  primary key (owner_id, doc_id, id)
);

create index if not exists data_row_changes on data_row (owner_id, doc_id, updated_at);

-- Los vínculos de cada tabla que salen de sus celdas (para sumarlos a los que
-- se le pusieron a mano con «Vincular» sin pisarlos). Ver `syncTableLinks`.
create table if not exists data_meta (
  owner_id text not null,
  doc_id text not null,
  derived_links text not null default '[]',
  primary key (owner_id, doc_id)
);
