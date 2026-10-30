-- Recuadro de firma en un PDF (ver `src/server/signature.ts`).
-- La imagen no se guarda: se estampa en el archivo y se descarta.
-- `page` y `box_*` vacíos son filas antiguas de confirmación, que ya no se usan.
-- `doc_signature_file` es la clave del PDF tras el último estampado. Si el
-- archivo cambia por otro motivo, las firmas quedan sobre la versión anterior.

alter table doc_signature add column if not exists page int;
alter table doc_signature add column if not exists box_x double precision;
alter table doc_signature add column if not exists box_y double precision;
alter table doc_signature add column if not exists box_w double precision;
alter table doc_signature add column if not exists box_h double precision;

create table if not exists doc_signature_file (
  owner_id text not null,
  doc_id text not null,
  file_key text not null,
  primary key (owner_id, doc_id)
);
