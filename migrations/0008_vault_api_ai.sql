-- Bóveda en el servidor, API REST y asistente de IA.

-- La bóveda de cada usuario. El navegador conserva una copia y se sincroniza
-- por revisiones: cada cambio recibe la siguiente revisión del usuario y las
-- bajas quedan como lápida (deleted = true) para que los demás navegadores se
-- enteren.
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

-- Tokens personales para la API REST. Solo se guarda el hash; el token se
-- muestra una única vez al crearlo.
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

-- Proveedores de IA que el administrador permite. base_url solo para los
-- locales (Ollama, LM Studio): la fija el administrador, no cada usuario, para
-- que nadie pueda hacer que el servidor llame a otras direcciones internas.
create table if not exists ai_provider (
  id text primary key,
  enabled boolean not null default false,
  base_url text not null default ''
);

-- Credenciales de IA de cada usuario. api_key va cifrada (AES-256-GCM con
-- GRAFITO_ENCRYPTION_KEY); key_hint guarda solo los 4 últimos caracteres.
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
