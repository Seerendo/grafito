create table if not exists app_admin (
  user_id text primary key references "user" ("id") on delete cascade,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists app_role (
  id text primary key,
  name text not null unique,
  fixed boolean not null default false
);

create table if not exists app_permission (
  key text primary key,
  label text not null,
  description text not null
);

create table if not exists app_role_permission (
  role_id text not null references app_role (id) on delete cascade,
  permission_key text not null references app_permission (key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists app_source (
  id text primary key,
  kind text not null,
  label text not null,
  enabled boolean not null default true
);

create table if not exists app_plugin (
  id text primary key,
  name text not null,
  description text not null,
  enabled boolean not null default true,
  built_in boolean not null default false
);

create table if not exists doc_index (
  user_id text not null,
  doc_id text not null,
  title text not null,
  kind text not null,
  portfolio_id text,
  body text not null default '',
  links_json text not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (user_id, doc_id)
);

create index if not exists doc_index_user_idx on doc_index (user_id);

insert into app_role (id, name, fixed) values
  ('admin', 'Administrador', true),
  ('editor', 'Editor', false),
  ('lector', 'Lector', false)
on conflict (id) do nothing;

insert into app_permission (key, label, description) values
  ('admin.access', 'Administrar', 'Entrar a la ventana de administración'),
  ('vault.read', 'Leer', 'Ver notas y archivos'),
  ('vault.write', 'Escribir', 'Crear y editar documentos'),
  ('sources.manage', 'Fuentes', 'Ver el estado de Postgres, el índice y el bucket'),
  ('plugins.manage', 'Plugins', 'Activar o pausar plugins')
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key)
select 'admin', key from app_permission
on conflict do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('editor', 'vault.read'),
  ('editor', 'vault.write'),
  ('lector', 'vault.read')
on conflict do nothing;

insert into app_source (id, kind, label, enabled) values
  ('relational', 'relacional', 'Cuentas, permisos, fuentes y plugins', true),
  ('documents', 'documentos', 'Notas y referencias', true),
  ('files', 'archivos', 'Archivos subidos', true)
on conflict (id) do nothing;

insert into app_plugin (id, name, description, enabled, built_in) values
  ('mermaid', 'Mermaid', 'Diagramas, incluido C4, dentro de las notas', true, true),
  ('grafo', 'Grafo', 'Mapa de wiki, referencias e invocaciones', true, true),
  ('vinculos', 'Vínculos', 'Referencias e invocaciones entre documentos', true, true)
on conflict (id) do nothing;
