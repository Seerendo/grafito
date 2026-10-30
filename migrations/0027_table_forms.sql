-- Tablas de datos, fase 2 (ver `src/server/table.ts` y `domain/vault/table.ts`).
-- El texto de las celdas se guarda para buscarlo (la barra, Elasticsearch y la
-- IA). El formulario es uno por tabla: qué columnas pide y, si está abierto,
-- el token del enlace público (cualquiera puede añadir una fila, no verlas).

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
