-- Structured audit for administration monitoring. app_log remains the short log. Each audit row
-- has action, outcome and target; entries can be filtered and exported, with retention controlled
-- by app_setting.audit_retention_days.

create table if not exists audit_event (
  id text primary key,
  at timestamptz not null default now(),
  actor_id text,
  actor_name text not null default '',
  action text not null,
  outcome text not null,
  area text not null default '',
  target text not null default '',
  detail text not null default '',
  ip text not null default ''
);

create index if not exists audit_event_at_idx on audit_event (at desc);
create index if not exists audit_event_actor_idx on audit_event (actor_id, at desc);
create index if not exists audit_event_action_idx on audit_event (action, at desc);

insert into app_setting (key, value) values ('audit_retention_days', '365')
on conflict (key) do nothing;

-- Import existing short-log entries once, preserving IDs.
insert into audit_event (id, at, actor_id, actor_name, action, outcome, area, target, detail, ip)
select id, at, null, actor, 'admin', 'ok', area, '', message, ''
from app_log
on conflict (id) do nothing;
