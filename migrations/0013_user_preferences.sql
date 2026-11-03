-- Per-user preferences: interface language, es or en; empty means the browser language.
alter table app_profile add column if not exists locale text;
