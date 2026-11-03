-- Antivirus administration permission. Store host, port and timeout in clamav_* settings. Without
-- settings, scanning remains enabled at clamav:3310.

insert into app_permission (key, label, description, area, sort) values
  ('security.manage', 'Seguridad', 'Configurar el antivirus (ClamAV)', 'Administración', 78)
on conflict (key) do nothing;

insert into app_role_permission (role_id, permission_key) values
  ('admin', 'security.manage')
on conflict do nothing;
