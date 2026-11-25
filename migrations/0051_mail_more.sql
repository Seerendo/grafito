-- Signatures, recipients by name and the calendar.
--
-- signature: plain text added below new messages and replies of the account.
-- web_host: the server's web address (Zimbra: SOAP directory, CalDAV); empty means the IMAP host.
-- directory: whether the account's server answers name searches (Zimbra's GAL): auto (not tried
-- yet), zimbra, none.
-- caldav_url: where the calendars are; empty means https://<web host>/.well-known/caldav.

alter table mail_account add column if not exists signature text not null default '';
alter table mail_account add column if not exists web_host text not null default '';
alter table mail_account add column if not exists directory text not null default 'auto';
alter table mail_account add column if not exists caldav_url text not null default '';

-- People the person wrote to or heard from, for suggestions while writing. Filled by the sync and
-- by sending; private to its owner like the rest of the mail.
create table if not exists mail_contact (
  user_id text not null references "user"(id) on delete cascade,
  address text not null,
  name text not null default '',
  uses integer not null default 1,
  last_at bigint not null default 0,
  primary key (user_id, address)
);
create index if not exists mail_contact_name on mail_contact (user_id, lower(name));

insert into mail_contact (user_id, address, name, uses, last_at)
select user_id, address, max(name), count(*), max(at)
from (
  select m.user_id, lower(m.from_address) as address, m.from_name as name, m.received_at as at
  from mail_message m where m.from_address <> ''
  union all
  select m.user_id, lower(p ->> 'address'), coalesce(p ->> 'name', ''), m.received_at
  from mail_message m, jsonb_array_elements(case when m.to_json like '[%' then m.to_json::jsonb else '[]'::jsonb end) p
  union all
  select m.user_id, lower(p ->> 'address'), coalesce(p ->> 'name', ''), m.received_at
  from mail_message m, jsonb_array_elements(case when m.cc_json like '[%' then m.cc_json::jsonb else '[]'::jsonb end) p
) seen
where address like '%@%'
group by user_id, address
on conflict (user_id, address) do nothing;

-- The calendars found on an account's CalDAV server, and which ones show.
create table if not exists mail_calendar (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  account_id text not null references mail_account(id) on delete cascade,
  href text not null,
  name text not null default '',
  color text not null default '',
  writable boolean not null default true,
  shown boolean not null default true,
  updated_at bigint not null default 0,
  unique (account_id, href)
);
create index if not exists mail_calendar_user on mail_calendar (user_id);
