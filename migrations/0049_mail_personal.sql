-- Email accounts are each person's own: they are set up in the Account, not in the administration.
-- The administrator's permission goes; institutional profiles and the administrator's pause are no
-- longer used (OAuth applications and private IMAP hosts come from the server's environment).
-- mail_profile and mail_account.admin_paused stay so no data is dropped.

update mail_account set admin_paused = false,
  status = case when status = 'paused' then 'connected' else status end
where admin_paused;

update mail_account set profile_id = null where profile_id is not null;

delete from app_role_permission where permission_key = 'mailbox.manage';
delete from app_permission where key = 'mailbox.manage';
