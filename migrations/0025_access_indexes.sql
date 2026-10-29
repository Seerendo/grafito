-- Índices para muchas organizaciones y mucho compartido (optimización del
-- 29-10-2026):
--  - lo compartido con las organizaciones de alguien se busca por organización
--    (la clave de `share_org_grant` empieza por el elemento);
--  - la papelera (listar, vaciar lo vencido) ya no recorre todos los
--    documentos de la bóveda, solo los borrados.
create index if not exists share_org_grant_org_idx on share_org_grant (org_id);
create index if not exists vault_doc_trash on vault_doc (user_id, deleted_at) where deleted and deleted_at is not null;
create index if not exists vault_portfolio_trash on vault_portfolio (user_id) where deleted and deleted_at is not null;
