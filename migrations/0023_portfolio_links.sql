-- Portfolio descriptions and manual links to personal or shared notes, files and portfolios. See
-- ManualLink in domain/vault/types.ts.
alter table vault_portfolio add column if not exists description text not null default '';
alter table vault_portfolio add column if not exists links_json text not null default '[]';
