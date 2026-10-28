-- Espacio y permisos por portafolio.
--
-- Espacio: solo cuentan los archivos (su versión actual, también en la
-- papelera hasta vaciarla; no el historial). Hay tres topes, todos opcionales
-- (sin fila = sin tope):
--   space_user       lo que un usuario sube en total, en cualquier portafolio;
--   space_portfolio  lo que cabe en un portafolio con sus subportafolios
--                    (lo pone el administrador del sistema);
--   space_member     lo que un usuario puede subir dentro de un portafolio
--                    (lo ponen el dueño, quien lo administra o el
--                    administrador del sistema), dentro del de ese portafolio.
-- `app_setting.space_default_user`: el tope por usuario cuando no tiene uno propio.
--
-- Permisos: además de «Solo lectura» y «Puede editar» (que ahora también deja
-- crear notas y subir archivos dentro de un portafolio compartido), «admin»
-- administra el portafolio: reparte su espacio y cambia los permisos de los
-- demás. El nivel puede fijarse por invitado (`share_grant.access`,
-- `share_org_grant.access`); sin él vale el del elemento compartido.

alter table share_item drop constraint if exists share_item_access_check;
alter table share_item add constraint share_item_access_check check (access in ('read', 'edit', 'admin'));

alter table share_grant add column if not exists access text check (access in ('read', 'edit', 'admin'));
alter table share_org_grant add column if not exists access text check (access in ('read', 'edit', 'admin'));

-- Quién subió cada archivo (para el espacio de cada usuario). Vacío: el dueño.
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
