-- Per-user workspace portfolio access. Without a row, members see the workspace but not its
-- contents. Administrators grant access and may propagate it to descendant portfolios.

create table if not exists workspace_access (
  owner_id text not null,
  portfolio_id text not null,
  user_id text not null,
  access text not null check (access in ('read', 'edit')),
  primary key (owner_id, portfolio_id, user_id)
);

create index if not exists workspace_access_user on workspace_access (owner_id, user_id);

-- Organizations no longer inherit full edit access. Only directly granted administrators edit
-- everything; nested access is granted separately.
update share_item set access = 'read'
where id in (select share_id from workspace) and access = 'edit';
