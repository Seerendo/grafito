-- PDF signature rectangle; see src/server/signature.ts. Stamp the image into the file and discard
-- it. Empty page and box_* fields identify obsolete confirmation rows. doc_signature_file
-- identifies the last stamped PDF; unrelated file changes leave signatures on the previous
-- version.

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
