-- Ollama and LM Studio: users connect their own instances. Administrators control availability;
-- users configure addresses.
alter table ai_credential add column if not exists base_url text not null default '';
alter table ai_provider drop column if exists base_url;
