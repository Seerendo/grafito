-- Spam and trash sync like the other folders, as the mail server shows them. Views that repeat
-- other folders' messages (Gmail's All Mail and Important, a Starred folder) stay off.
update mail_folder set sync_enabled = true, updated_at = (extract(epoch from now()) * 1000)::bigint
where special_use in ('junk', 'trash') and not sync_enabled and not removed;
update mail_account set next_sync_at = 0
where id in (select account_id from mail_folder where special_use in ('junk', 'trash') and sync_enabled)
  and secret <> '';
