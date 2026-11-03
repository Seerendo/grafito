-- Organization workspaces belong to an internal account (owner_id) with no password or sign-in.
-- They are shared with the organization and descendants via share_id; administrators receive
-- direct admin grants. See src/server/workspace.ts. bytes is the total quota, null for unlimited.
-- Child organization allocations cannot exceed it; the workspace uses the remainder. Workspace
-- uploads do not count toward personal quotas.
create table if not exists workspace (
  org_id text primary key references app_org (id) on delete cascade,
  owner_id text not null unique references "user" ("id") on delete cascade,
  root_portfolio_id text not null,
  share_id text not null,
  bytes bigint check (bytes >= 0),
  created_at bigint not null
);
