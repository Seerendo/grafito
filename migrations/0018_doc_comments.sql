-- Document comments can be added by owners and shared recipients, including read-only recipients.
-- Remove them when the document is purged from trash.
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
