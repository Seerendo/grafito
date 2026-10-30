-- Tablas de datos, fase 3 (ver `src/server/table.ts`).
-- `layout` recuerda la vista (cuadrícula, tablero, galería o calendario).
-- El historial guarda, por fila, qué celda cambió (como mucho las últimas
-- cuarenta), para poder ver quién la tocó y el valor anterior.

alter table data_meta add column if not exists layout text not null default '';

create table if not exists data_row_history (
  owner_id text not null,
  doc_id text not null,
  id text not null,
  row_id text not null,
  at bigint not null,
  actor text not null default '',
  kind text not null,
  changes jsonb not null default '[]'::jsonb,
  primary key (owner_id, doc_id, id)
);

create index if not exists data_row_history_row on data_row_history (owner_id, doc_id, row_id, at desc);
