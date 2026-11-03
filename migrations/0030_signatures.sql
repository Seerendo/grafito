-- Document signature tracking; see src/server/signature.ts. Each row requests confirmation of a
-- version, not a certificate. fingerprint is that version's SHA-256 at signing time. Later
-- changes leave the signature attached to the earlier version. Status is pending, signed or
-- declined.

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
