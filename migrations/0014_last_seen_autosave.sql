-- First sign-in and last activity for the administration user list.
alter table app_profile add column if not exists first_login_at timestamptz;
alter table app_profile add column if not exists last_seen_at timestamptz;

-- Backfill from sessions that still exist.
insert into app_profile (user_id)
select distinct "userId" from "session"
on conflict (user_id) do nothing;

update app_profile as p
set first_login_at = s.first_at, last_seen_at = s.last_at
from (
  select "userId" as user_id, min("createdAt") as first_at, max("updatedAt") as last_at
  from "session" group by "userId"
) as s
where s.user_id = p.user_id and p.first_login_at is null;

-- Only Office autosave versions are grouped; explicit user saves always remain separate.
alter table vault_doc_version add column if not exists autosave boolean not null default false;
