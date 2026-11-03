-- Portfolio storage and permissions. Only current file versions count, including trash until
-- purged; history does not. Optional limits: space_user covers all user uploads; space_portfolio
-- covers a portfolio subtree and is set by system administrators; space_member limits one user's
-- uploads within that portfolio and is set by its owner or administrators. Missing rows mean
-- unlimited. app_setting.space_default_user supplies the default personal limit. Edit access
-- permits creating notes and uploading files; admin also manages allocation and grants.
-- Per-recipient access overrides share_item access.

alter table share_item drop constraint if exists share_item_access_check;
alter table share_item add constraint share_item_access_check check (access in ('read', 'edit', 'admin'));

alter table share_grant add column if not exists access text check (access in ('read', 'edit', 'admin'));
alter table share_org_grant add column if not exists access text check (access in ('read', 'edit', 'admin'));

-- Uploader used for personal storage accounting; empty means the owner.
alter table vault_doc add column if not exists uploaded_by text;
create index if not exists vault_doc_uploaded_by on vault_doc (uploaded_by) where kind = 'file';

create table if not exists space_user (
  user_id text primary key references "user" ("id") on delete cascade,
  bytes bigint not null check (bytes >= 0)
);

create table if not exists space_portfolio (
  owner_id text not null references "user" ("id") on delete cascade,
  portfolio_id text not null,
  bytes bigint not null check (bytes >= 0),
  primary key (owner_id, portfolio_id)
);

create table if not exists space_member (
  owner_id text not null references "user" ("id") on delete cascade,
  portfolio_id text not null,
  user_id text not null references "user" ("id") on delete cascade,
  bytes bigint not null check (bytes >= 0),
  primary key (owner_id, portfolio_id, user_id)
);

insert into app_permission (key, label, description, area, sort) values
  ('space.manage', 'Espacio', 'Asignar espacio a usuarios y portafolios', 'Administración', 77)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'space.manage')
on conflict do nothing;
