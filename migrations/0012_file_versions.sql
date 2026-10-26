-- Versiones de archivos (documentos de Office editados en Grafito): cada
-- guardado deja su objeto en el almacén y una fila en vault_doc_version con
-- su clave. Las notas siguen guardando su texto en `content`.
alter table vault_doc_version add column if not exists file_key text;
alter table vault_doc_version add column if not exists file_size bigint;
