-- Perfiles del chat de IA de cada usuario («Documentación», «Análisis»…): un
-- nombre, las indicaciones que se suman a las del asistente y si el perfil
-- solo puede leer la bóveda (sin crear ni editar).
create table if not exists ai_profile (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  name text not null,
  instructions text not null default '',
  read_only boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists ai_profile_user on ai_profile (user_id, name);
