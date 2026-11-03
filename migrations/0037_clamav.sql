-- Antivirus (Administración → Seguridad). El permiso abre esa pantalla.
-- Host, puerto y plazo se guardan en app_setting (claves clamav_*).
-- Sin esa fila, el análisis queda activo en clamav:3310.

insert into app_permission (key, label, description, area, sort) values
  ('security.manage', 'Seguridad', 'Configurar el antivirus (ClamAV)', 'Administración', 78)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'security.manage')
on conflict do nothing;
