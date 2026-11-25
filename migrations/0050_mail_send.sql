-- Sending mail: an IMAP account's SMTP submission server (465 TLS or 587 STARTTLS). An empty host
-- means the IMAP host. Gmail and Microsoft accounts send through their APIs and need to be
-- authorized again for the new send scope.

alter table mail_account add column if not exists smtp_host text not null default '';
alter table mail_account add column if not exists smtp_port integer not null default 587;
