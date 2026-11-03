-- Bidirectional Git sync with GitHub or GitLab, including self-hosted instances. Mirror a
-- portfolio or the entire vault (all) into a repository folder. The optional git plugin defaults
-- off; git.sync initially belongs only to administrators. See src/server/git/sync.ts.

insert into app_plugin (id, name, description, enabled, built_in) values
  ('git', 'Git', 'Sincronizar portafolios con un repositorio de GitHub o GitLab', false, true)
on conflict (id) do nothing;

insert into app_permission (key, label, description, area, sort) values
  ('git.sync', 'Git', 'Sincronizar portafolios con un repositorio de GitHub o GitLab', 'Portafolios', 31)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'git.sync')
on conflict do nothing;

-- Portfolio linked to a repository folder. token is encrypted with GRAFITO_ENCRYPTION_KEY;
-- hook_secret signs optional webhooks; head records the last synchronized commit.
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

-- Last synchronized state for each repository file: Git blob, document timestamp, title and
-- portfolio preserve unchanged paths. base stores note text for merging concurrent changes.
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
