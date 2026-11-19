-- Plugins become extensions. Each one is checked before it can be turned on (src/server/extensions.ts):
-- one that needs a service (Grafo → Grafeno, LaTeX → latex, OCR → ocr) only runs while that
-- service answers, and picks up where it left off when it comes back. The table and the
-- plugins.manage key keep their names, so roles and existing choices carry over.

update app_permission set label = 'Extensiones', description = 'Activar o pausar extensiones'
where key = 'plugins.manage';

update app_source set label = 'Cuentas, permisos, fuentes y extensiones'
where id = 'relational' and label = 'Cuentas, permisos, fuentes y plugins';

insert into app_plugin (id, name, description, enabled, built_in) values
  ('latex', 'LaTeX', 'Documentos LaTeX compilados a PDF', true, true),
  ('ocr', 'OCR', 'Texto de PDF escaneados e imágenes en la búsqueda', true, true)
on conflict (id) do nothing;

-- Documents whose OCR failed only because the service was not answering go back to the queue.
update ocr_text set state = 'pending', error = ''
where state = 'failed' and (error in ('fetch failed', 'OCR apagado.') or error like '%ECONNREFUSED%');
