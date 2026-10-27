-- Primer ingreso y última conexión de cada usuario (Administración → Usuarios).
alter table app_profile add column if not exists first_login_at timestamptz;
alter table app_profile add column if not exists last_seen_at timestamptz;

-- Con los datos que ya hay: las sesiones que siguen guardadas.
insert into app_profile (user_id)
select distinct "userId" from "session"
on conflict (user_id) do nothing;

update app_profile as p
set first_login_at = s.first_at, last_seen_at = s.last_at
from (
  select "userId" as user_id, min("createdAt") as first_at, max("updatedAt") as last_at
  from "session" group by "userId"
) as s
where s.user_id = p.user_id and p.first_login_at is null;

-- Versiones de archivos guardadas por el autoguardado del editor de Office:
-- solo esas se agrupan; un guardado de la persona siempre queda aparte.
alter table vault_doc_version add column if not exists autosave boolean not null default false;
