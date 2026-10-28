-- Sincronización con Git (GitHub, GitLab, también instalaciones propias): un
-- portafolio (o toda la bóveda, `all`) se refleja en una carpeta de un
-- repositorio, en ambos sentidos. Es opcional: el plugin `git` viene apagado
-- y el permiso `git.sync` solo lo tiene el administrador. Ver
-- `src/server/git/sync.ts`.

insert into app_plugin (id, name, description, enabled, built_in) values
  ('git', 'Git', 'Sincronizar portafolios con un repositorio de GitHub o GitLab', false, true)
on conflict (id) do nothing;

insert into app_permission (key, label, description, area, sort) values
  ('git.sync', 'Git', 'Sincronizar portafolios con un repositorio de GitHub o GitLab', 'Portafolios', 31)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'git.sync')
on conflict do nothing;

-- Un portafolio enlazado con una carpeta de un repositorio. `token` va cifrado
-- (GRAFITO_ENCRYPTION_KEY); `hook_secret` firma los webhooks opcionales;
-- `head`, el último commit sincronizado.
create table if not exists git_link (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  portfolio_id text not null,
  provider text not null check (provider in ('github', 'gitlab')),
  base_url text not null,
  repo text not null,
  branch text not null,
  folder text not null default '',
  direction text not null default 'both' check (direction in ('both', 'push', 'pull')),
  token text not null,
  hook_secret text not null,
  head text,
  pending boolean not null default true,
  last_error text not null default '',
  last_sync_at bigint,
  last_summary text not null default '',
  created_at bigint not null,
  unique (user_id, portfolio_id)
);

-- Cada archivo del repositorio enlazado con un documento, como quedó en la
-- última sincronización: el blob de Git, la fecha del documento, su título y
-- portafolio (para no cambiar la ruta si no cambian), y el texto de la nota
-- (`base`, para unir cambios hechos a la vez en los dos lados).
create table if not exists git_link_file (
  link_id text not null references git_link (id) on delete cascade,
  path text not null,
  doc_id text not null,
  blob_sha text not null,
  doc_updated_at bigint not null,
  doc_title text not null,
  doc_portfolio text,
  base text,
  primary key (link_id, path)
);

create index if not exists git_link_file_doc on git_link_file (link_id, doc_id);
