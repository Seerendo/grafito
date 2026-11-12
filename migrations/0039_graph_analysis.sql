-- Communities and importance of each vault's documents, computed in Grafeno (Louvain and
-- PageRank over the resolved links) and kept here so every app instance reads the same result
-- (see src/server/graph/analysis.ts). rev is the vault revision analysed; data is JSON.

create table if not exists graph_analysis (
  owner_id text primary key,
  rev bigint not null default -1,
  analyzed_at bigint not null default 0,
  data text not null default '{}'
);
