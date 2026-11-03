-- Document revision indexed for content search. Reindexing clears it and scans again in the
-- background without stopping Grafito.
create table if not exists content_index (
  user_id text not null,
  doc_id text not null,
  rev bigint not null,
  chars int not null default 0,
  ok boolean not null default true,
  error text not null default '',
  indexed_at bigint not null,
  primary key (user_id, doc_id)
);

-- Current indexing title and last error for monitoring.
create table if not exists index_run (
  id text primary key,
  current_title text not null default '',
  last_error text not null default '',
  updated_at bigint not null default 0
);

insert into index_run (id, updated_at) values ('content', 0)
on conflict (id) do nothing;
