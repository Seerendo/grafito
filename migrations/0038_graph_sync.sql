-- How far each vault is copied into Grafeno, the graph engine (see src/server/graph/sync.ts).
-- rev is the vault_state revision last written there. A vault without a row is copied whole.
-- Deleting the rows makes every vault copy again.

create table if not exists graph_sync (
  owner_id text primary key,
  rev bigint not null default 0,
  synced_at bigint not null default 0,
  last_error text not null default ''
);

update app_plugin set description = 'Mapa de wiki, referencias e invocaciones (Grafeno)'
where id = 'grafo';
