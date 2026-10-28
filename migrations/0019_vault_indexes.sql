-- Índices para bóvedas grandes (pruebas de carga del 28-10-2026):
--  - listar las notas de alguien por fecha ya no ordena la tabla entera;
--  - buscar texto con `ilike '%…%'` (API, IA) usa trigramas en vez de leer el
--    contenido de todas las notas. pg_trgm viene con Postgres (contrib) y es
--    de confianza: el dueño de la base puede activarlo.
create extension if not exists pg_trgm;

create index if not exists vault_doc_user_updated on vault_doc (user_id, updated_at desc) where not deleted;
create index if not exists vault_doc_title_trgm on vault_doc using gin (title gin_trgm_ops);
create index if not exists vault_doc_content_trgm on vault_doc using gin (content gin_trgm_ops);
