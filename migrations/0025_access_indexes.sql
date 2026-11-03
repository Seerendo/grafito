-- Access indexes added on 2026-10-29. Look up organization shares by organization, since the
-- existing key starts with the item. Trash listing and expiry scan only deleted documents.
create index if not exists share_org_grant_org_idx on share_org_grant (org_id);
create index if not exists vault_doc_trash on vault_doc (user_id, deleted_at) where deleted and deleted_at is not null;
create index if not exists vault_portfolio_trash on vault_portfolio (user_id) where deleted and deleted_at is not null;
