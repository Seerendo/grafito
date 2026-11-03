-- Office file versions: each save stores an object and its key in vault_doc_version. Markdown
-- notes continue storing their text in content.
alter table vault_doc_version add column if not exists file_key text;
alter table vault_doc_version add column if not exists file_size bigint;
