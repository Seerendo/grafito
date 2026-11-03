-- Large-vault indexes, load-tested on 2026-10-28. Listing by date avoids sorting the entire
-- table. Trigram indexes accelerate ILIKE searches used by API and AI. pg_trgm is a trusted
-- Postgres contrib extension that database owners may enable.
create extension if not exists pg_trgm;

create index if not exists vault_doc_user_updated on vault_doc (user_id, updated_at desc) where not deleted;
create index if not exists vault_doc_title_trgm on vault_doc using gin (title gin_trgm_ops);
create index if not exists vault_doc_content_trgm on vault_doc using gin (content gin_trgm_ops);
