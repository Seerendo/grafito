create table if not exists app_setting (
  key text primary key,
  value text not null
);

insert into app_setting (key, value)
values ('session_ttl_seconds', '28800')
on conflict (key) do nothing;

create table if not exists app_lease (
  user_id text primary key references "user" ("id") on delete cascade,
  expires_at timestamptz not null
);

create table if not exists app_profile (
  user_id text primary key references "user" ("id") on delete cascade,
  contact_email text
);

update "user" as u
set name = 'Administrador', "updatedAt" = now()
from app_admin as a
where a.user_id = u.id
  and lower(u.name) = lower(a.login_name);
