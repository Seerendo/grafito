alter table app_admin add column if not exists login_name text not null default 'admin';
alter table app_admin add column if not exists chosen boolean not null default false;
