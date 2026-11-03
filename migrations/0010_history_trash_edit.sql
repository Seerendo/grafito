-- Version history, trash and editable shares.

-- Shares default to read-only and may allow editing. Public shares are always read-only.
alter table share_item add column if not exists access text not null default 'read';
alter table share_item drop constraint if exists share_item_access_check;
alter table share_item add constraint share_item_access_check check (access in ('read', 'edit'));

-- Trash retains deletion time in milliseconds and content until purged or expired. Legacy
-- tombstones without deleted_at contain no content and are excluded from trash.
alter table vault_doc add column if not exists deleted_at bigint;
alter table vault_portfolio add column if not exists deleted_at bigint;

-- Note versions store state after each change. Consecutive edits by the same person are grouped;
-- see server/history.ts.
create table if not exists vault_doc_version (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  doc_id text not null,
  title text not null,
  content text not null,
  author text not null default '',
  created_at bigint not null
);

create index if not exists vault_doc_version_doc_idx on vault_doc_version (user_id, doc_id, created_at desc);

-- Seed version history with each existing note's current version.
insert into vault_doc_version (id, user_id, doc_id, title, content, author, created_at)
select gen_random_uuid()::text, user_id, id, title, content, updated_by, updated_at
from vault_doc
where not deleted and kind = 'markdown'
on conflict do nothing;
