-- Correo electrónico (SMTP): configuración en app_setting (claves mail_*),
-- avisos de cambios y acceso inicial de los usuarios nuevos por correo.

insert into app_permission (key, label, description, area, sort) values
  ('mail.manage', 'Correo electrónico', 'Configurar el servidor de correo (SMTP)', 'Administración', 76)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'mail.manage')
on conflict do nothing;

-- Cuenta → Correo: si la persona quiere avisos de cambios por correo.
alter table app_profile add column if not exists notify_changes boolean not null default true;

-- Contraseña temporal de un usuario nuevo (o reenviada): vence en expires_at,
-- sirve para entrar una sola vez (used_at) y obliga a cambiarla. La fila se
-- borra al cambiarla. note_id es la nota secreta del correo, para anularla al
-- reenviar; password_hash, el hash temporal, para saber si ya la cambió.
create table if not exists app_temp_access (
  user_id text primary key references "user" ("id") on delete cascade,
  expires_at bigint not null,
  used_at bigint,
  note_id text,
  password_hash text not null,
  created_at bigint not null
);

-- Notas secretas (la contraseña temporal) cuando no hay Redis. Solo guardan
-- el texto cifrado con una clave que va en el enlace del correo, nunca aquí.
create table if not exists app_secret_note (
  id text primary key,
  sealed text not null,
  expires_at bigint not null
);

-- Avisos de cambios pendientes de enviar: uno por persona y documento. Se
-- envían juntos cuando el documento lleva un rato sin cambios.
create table if not exists mail_notice (
  recipient_id text not null references "user" ("id") on delete cascade,
  owner_id text not null,
  doc_id text not null,
  actors text not null default '',
  first_at bigint not null,
  last_at bigint not null,
  primary key (recipient_id, owner_id, doc_id)
);
