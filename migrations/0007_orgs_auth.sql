-- Organizations and external sign-in providers.

-- Hierarchical organizations: a null parent_id denotes a root.
create table if not exists app_org (
  id text primary key,
  name text not null,
  parent_id text references app_org(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists app_org_parent_idx on app_org (parent_id);

create table if not exists app_org_member (
  org_id text not null references app_org(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  primary key (org_id, user_id)
);

create index if not exists app_org_member_user_idx on app_org_member (user_id);

-- Organization shares include members of all descendant organizations; see server/share.ts.
create table if not exists share_org_grant (
  share_id text not null references share_item(id) on delete cascade,
  org_id text not null references app_org(id) on delete cascade,
  primary key (share_id, org_id)
);

-- External providers: ldap, google, github, microsoft and sso (OIDC, such as Keycloak). config
-- stores connection JSON including secrets; mask it before returning it to the browser.
create table if not exists auth_provider (
  id text primary key,
  enabled boolean not null default false,
  config text not null default '{}',
  default_role text not null default 'miembro' references app_role(id) on delete set default,
  allowed_domains text not null default '',
  updated_at timestamptz not null default now()
);

-- Provider that provisioned each account, for display and auditing.
alter table app_user_role add column if not exists source text not null default 'local';

insert into app_permission (key, label, description, area, sort) values
  ('orgs.manage', 'Organizaciones', 'Crear organizaciones y asignar miembros', 'Usuarios', 34),
  ('auth.manage', 'Autenticación', 'Configurar LDAP, OAuth y SSO', 'Administración', 46)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'orgs.manage'),
  ('admin', 'auth.manage')
on conflict do nothing;
