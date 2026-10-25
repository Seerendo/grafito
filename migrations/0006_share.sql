-- Compartir notas y portafolios en solo lectura.
--
-- Lo privado no tiene fila: es el valor por defecto. Una fila en share_item
-- hace visible una nota (kind = 'document') o un portafolio con todo lo que
-- contiene (kind = 'portfolio'):
--   visibility = 'shared' → los usuarios de share_grant, con sesión.
--   visibility = 'public' → cualquiera con el enlace /p/<public_token>, sin sesión.
--
-- Las notas viven en el navegador de su dueño; published_* guarda la copia que
-- se muestra a los demás y la actualiza el propio dueño al editar (ShareMirror).

create table if not exists share_item (
  id text primary key,
  owner_id text not null references "user"(id) on delete cascade,
  kind text not null check (kind in ('document', 'portfolio')),
  target_id text not null,
  title text not null default '',
  visibility text not null check (visibility in ('shared', 'public')),
  public_token text unique,
  updated_at timestamptz not null default now(),
  unique (owner_id, kind, target_id)
);

create index if not exists share_item_owner_idx on share_item (owner_id);

create table if not exists share_grant (
  share_id text not null references share_item(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  primary key (share_id, user_id)
);

create index if not exists share_grant_user_idx on share_grant (user_id);

create table if not exists published_doc (
  owner_id text not null references "user"(id) on delete cascade,
  doc_id text not null,
  title text not null,
  kind text not null check (kind in ('markdown', 'file')),
  portfolio_id text,
  content text not null default '',
  file_name text,
  file_mime text,
  file_data text,
  updated_by text not null default '',
  updated_at timestamptz not null default now(),
  primary key (owner_id, doc_id)
);

create table if not exists published_portfolio (
  owner_id text not null references "user"(id) on delete cascade,
  portfolio_id text not null,
  name text not null,
  parent_id text,
  primary key (owner_id, portfolio_id)
);

insert into app_permission (key, label, description, area, sort) values
  ('notes.share', 'Compartir', 'Hacer públicas o compartir notas y portafolios', 'Notas', 15)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'notes.share'),
  ('miembro', 'notes.share')
on conflict do nothing;
