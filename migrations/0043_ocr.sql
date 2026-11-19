-- Text recognized in scanned PDFs and images (server/ocr.ts). One row per document: the file
-- object it was read from, so a new version is read again.
create table if not exists ocr_text (
  owner_id text not null,
  doc_id text not null,
  file_key text not null,
  state text not null default 'pending',
  pages integer not null default 0,
  text text not null default '',
  error text not null default '',
  updated_at bigint not null,
  primary key (owner_id, doc_id)
);
create index if not exists ocr_text_pending on ocr_text (state, updated_at);
