-- OCR is removed, and no other engine replaces it. Scanned PDFs and images stay stored and can be
-- viewed and downloaded as before; their content is no longer searchable text (their name is).
-- Nothing the person wrote or uploaded is touched: ocr_text only held text recognized from
-- stored files, which are kept. No other table, view or constraint refers to it.

-- Documents whose search text came from OCR are indexed again (server/index/run.ts), now
-- without it, so search stops finding words that only the OCR had read.
delete from content_index c
using ocr_text o
where c.user_id = o.owner_id and c.doc_id = o.doc_id and o.state = 'done';

-- The extension leaves Administración → Extensiones.
delete from app_plugin where id = 'ocr';

drop table if exists ocr_text;
