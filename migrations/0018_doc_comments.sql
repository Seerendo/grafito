-- Comentarios sobre una nota o un archivo, sin editarlo: los deja su dueño o
-- cualquiera con quien esté compartido (también en solo lectura). Se borran
-- al vaciar el documento de la papelera.
create table if not exists doc_comment (
  id text primary key,
  owner_id text not null references "user" ("id") on delete cascade,
  doc_id text not null,
  author_id text references "user" ("id") on delete set null,
  author_name text not null default '',
  body text not null,
  created_at bigint not null
);

create index if not exists doc_comment_doc on doc_comment (owner_id, doc_id, created_at);
