-- Server vault, REST API and AI assistant.

-- Per-user vault. Browsers keep a copy synchronized by revision. Every change advances the user's
-- revision; deleted rows remain as tombstones so other browsers observe deletions.
create table if not exists vault_state (
  user_id text primary key references "user"(id) on delete cascade,
  revision bigint not null default 0
);

create table if not exists vault_portfolio (
  user_id text not null references "user"(id) on delete cascade,
  id text not null,
  name text not null,
  parent_id text,
  rev bigint not null,
  deleted boolean not null default false,
  primary key (user_id, id)
);

create table if not exists vault_doc (
  user_id text not null references "user"(id) on delete cascade,
  id text not null,
  title text not null,
  kind text not null check (kind in ('markdown', 'file')),
  portfolio_id text,
  content text not null default '',
  file_name text,
  file_mime text,
  file_data text,
  links_json text not null default '[]',
  pinned boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  created_by text not null default '',
  updated_by text not null default '',
  rev bigint not null,
  deleted boolean not null default false,
  primary key (user_id, id)
);

create index if not exists vault_doc_rev_idx on vault_doc (user_id, rev);
create index if not exists vault_portfolio_rev_idx on vault_portfolio (user_id, rev);

-- Personal REST API tokens: store only the hash and reveal the token once, on creation.
create table if not exists api_token (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  name text not null,
  prefix text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists api_token_user_idx on api_token (user_id);

-- Administrator-enabled AI providers. Originally, only local providers (Ollama and LM Studio)
-- used base_url, configured by administrators to prevent requests to arbitrary internal
-- addresses.
create table if not exists ai_provider (
  id text primary key,
  enabled boolean not null default false,
  base_url text not null default ''
);

-- Per-user AI credentials. api_key uses AES-256-GCM with GRAFITO_ENCRYPTION_KEY; key_hint keeps
-- only the final four characters.
create table if not exists ai_credential (
  user_id text not null references "user"(id) on delete cascade,
  provider text not null,
  api_key text not null default '',
  key_hint text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

insert into app_permission (key, label, description, area, sort) values
  ('ai.use', 'Usar', 'Chatear con la IA sobre sus notas', 'IA', 60),
  ('ai.manage', 'Proveedores', 'Elegir qué proveedores de IA se permiten', 'IA', 61),
  ('api.use', 'API', 'Crear tokens personales para la API REST', 'IA', 62)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'ai.use'),
  ('admin', 'ai.manage'),
  ('admin', 'api.use'),
  ('miembro', 'ai.use'),
  ('miembro', 'api.use')
on conflict do nothing;
