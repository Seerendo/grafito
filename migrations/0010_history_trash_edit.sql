-- Historial de versiones, papelera y compartir con edición.

-- Compartir: solo lectura (por defecto) o edición. Lo público siempre es de
-- solo lectura.
alter table share_item add column if not exists access text not null default 'read';
alter table share_item drop constraint if exists share_item_access_check;
alter table share_item add constraint share_item_access_check check (access in ('read', 'edit'));

-- Papelera: una baja guarda el momento (ms) y conserva el contenido hasta que
-- se vacía o vence la retención. Las lápidas antiguas (sin deleted_at) no
-- tienen contenido y no aparecen en la papelera.
alter table vault_doc add column if not exists deleted_at bigint;
alter table vault_portfolio add column if not exists deleted_at bigint;

-- Versiones de cada nota. Se guarda el estado tras cada cambio; los cambios
-- seguidos de la misma persona se agrupan en una versión (ver server/history.ts).
create table if not exists vault_doc_version (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  doc_id text not null,
  title text not null,
  content text not null,
  author text not null default '',
  created_at bigint not null
);

create index if not exists vault_doc_version_doc_idx on vault_doc_version (user_id, doc_id, created_at desc);

-- Punto de partida: la versión actual de cada nota existente.
insert into vault_doc_version (id, user_id, doc_id, title, content, author, created_at)
select gen_random_uuid()::text, user_id, id, title, content, updated_by, updated_at
from vault_doc
where not deleted and kind = 'markdown'
on conflict do nothing;
