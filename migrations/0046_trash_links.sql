-- Manual links that other documents and portfolios had to something that went to the trash
-- (server/vault.ts detachLinks). The links are taken out of their sources when the target is
-- deleted and put back when it is restored; a row goes when either side is purged.
create table if not exists trash_link (
  user_id text not null,
  target_id text not null,
  source_kind text not null,
  source_id text not null,
  link_json text not null,
  deleted_at bigint not null,
  primary key (user_id, target_id, source_kind, source_id, link_json)
);

create index if not exists trash_link_source on trash_link (user_id, source_kind, source_id);
