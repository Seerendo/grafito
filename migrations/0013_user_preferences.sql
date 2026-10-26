-- Preferencias de cada usuario: por ahora, el idioma de la interfaz
-- ('es' o 'en'; vacío = el del navegador).
alter table app_profile add column if not exists locale text;
