-- Meetings: who sends the invitations of an account's events. server: its CalDAV server
-- schedules (RFC 6638, as Zimbra); email: Grafito sends iCalendar invitations by mail (RFC 6047);
-- empty until the calendars are looked up.

alter table mail_account add column if not exists calendar_scheduling text not null default '';

-- New mail by arrival, for wait_for_mail (MCP).
create index if not exists mail_message_arrival on mail_message (user_id, created_at);

-- The whole mailbox by default, like the mail server shows it: accounts left at the old 30-day
-- default look back again in every folder (custom folders, Drafts, Sent…), newest first.
update mail_account set history_days = 0 where history_days = 30;
update mail_sync_state set backfill_done = false, backfill_cursor = null,
  delta_link = case when (select provider from mail_account a where a.id = mail_sync_state.account_id) = 'microsoft'
    then null else delta_link end
where account_id in (select id from mail_account where history_days = 0);
update mail_account set next_sync_at = 0 where history_days = 0 and secret <> '';
