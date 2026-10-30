-- Seguimiento de firmas de un documento (ver `src/server/signature.ts`).
-- No es un certificado: cada fila es una persona a la que se le pidió
-- confirmar una versión. `fingerprint` es el SHA-256 de esa versión en el
-- momento de firmar; si el documento cambia después, la firma queda sobre
-- la versión anterior. `status`: pending, signed o declined.

create table if not exists doc_signature (
  id text primary key,
  owner_id text not null,
  doc_id text not null,
  signer_id text not null,
  signer_name text not null,
  status text not null,
  requested_by text not null,
  requested_by_name text not null,
  requested_at bigint not null,
  decided_at bigint,
  fingerprint text not null default '',
  note text not null default ''
);

create index if not exists doc_signature_doc on doc_signature (owner_id, doc_id, requested_at desc);
create index if not exists doc_signature_signer on doc_signature (signer_id, status);
