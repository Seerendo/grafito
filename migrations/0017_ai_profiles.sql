-- Per-user AI personas: name, additional assistant instructions and a read-only flag preventing
-- vault creation or editing.
create table if not exists ai_profile (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  name text not null,
  instructions text not null default '',
  read_only boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists ai_profile_user on ai_profile (user_id, name);
