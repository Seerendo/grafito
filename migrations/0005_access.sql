create table if not exists app_user_role (
  user_id text primary key references "user" ("id") on delete cascade,
  role_id text not null references app_role (id),
  login_name text not null unique
);

create table if not exists app_log (
  id text primary key,
  at timestamptz not null default now(),
  actor text not null default '',
  area text not null,
  message text not null
);

delete from app_role where id in ('editor', 'lector');

insert into app_role (id, name, fixed) values
  ('admin', 'Administrador', true),
  ('miembro', 'Miembro', true),
  ('anonimo', 'Anónimo', true)
on conflict (id) do update set name = excluded.name, fixed = excluded.fixed;

alter table app_permission add column if not exists area text not null default 'General';
alter table app_permission add column if not exists sort integer not null default 0;

delete from app_permission where key in ('vault.read', 'vault.write');

insert into app_permission (key, label, description, area, sort) values
  ('notes.read', 'Leer', 'Ver las notas', 'Notas', 10),
  ('notes.create', 'Crear', 'Crear notas', 'Notas', 11),
  ('notes.edit', 'Editar', 'Cambiar el texto', 'Notas', 12),
  ('notes.delete', 'Eliminar', 'Borrar notas', 'Notas', 13),
  ('notes.export', 'Exportar', 'Descargar Markdown o PDF', 'Notas', 14),
  ('files.upload', 'Subir', 'Subir archivos', 'Archivos', 20),
  ('files.download', 'Descargar', 'Descargar archivos', 'Archivos', 21),
  ('files.delete', 'Eliminar', 'Borrar archivos', 'Archivos', 22),
  ('portfolios.manage', 'Gestionar', 'Crear, renombrar y borrar portafolios', 'Portafolios', 30),
  ('links.manage', 'Vincular', 'Crear y quitar referencias', 'Vínculos', 40),
  ('graph.view', 'Ver', 'Abrir el grafo', 'Grafo', 50),
  ('users.create', 'Crear', 'Crear usuarios y darles contraseña', 'Usuarios', 60),
  ('users.update', 'Actualizar', 'Cambiar nombre, rol o contraseña', 'Usuarios', 61),
  ('users.delete', 'Eliminar', 'Borrar usuarios', 'Usuarios', 62),
  ('admin.access', 'Entrar', 'Abrir la administración', 'Administración', 70),
  ('roles.manage', 'Roles', 'Crear roles y asignar permisos', 'Administración', 71),
  ('sources.manage', 'Fuentes', 'Ver y pausar las fuentes', 'Administración', 72),
  ('plugins.manage', 'Plugins', 'Activar o pausar plugins', 'Administración', 73),
  ('session.manage', 'Sesión', 'Cambiar la duración de la sesión', 'Administración', 74),
  ('monitor.view', 'Monitor', 'Ver recursos y registros', 'Administración', 75)
on conflict (key) do update set
  label = excluded.label,
  description = excluded.description,
  area = excluded.area,
  sort = excluded.sort;

insert into app_role_permission (role_id, permission_key)
select 'admin', key from app_permission
on conflict do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('miembro', 'notes.read'),
  ('miembro', 'notes.create'),
  ('miembro', 'notes.edit'),
  ('miembro', 'notes.delete'),
  ('miembro', 'notes.export'),
  ('miembro', 'files.upload'),
  ('miembro', 'files.download'),
  ('miembro', 'files.delete'),
  ('miembro', 'portfolios.manage'),
  ('miembro', 'links.manage'),
  ('miembro', 'graph.view'),
  ('anonimo', 'notes.read'),
  ('anonimo', 'files.download'),
  ('anonimo', 'graph.view')
on conflict do nothing;

insert into app_user_role (user_id, role_id, login_name)
select user_id, 'admin', login_name from app_admin
on conflict (user_id) do update set role_id = 'admin';
