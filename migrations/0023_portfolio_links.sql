-- Portafolios con descripción y vínculos propios (como los de una nota: a
-- notas, archivos o portafolios, propios o de lo compartido conmigo). Ver
-- `domain/vault/types.ts` (`ManualLink`).
alter table vault_portfolio add column if not exists description text not null default '';
alter table vault_portfolio add column if not exists links_json text not null default '[]';
