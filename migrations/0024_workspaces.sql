-- Espacios de trabajo: los portafolios de una organización, que no son de
-- ninguna persona. Cada uno vive en la bóveda de una cuenta interna (`owner_id`,
-- sin contraseña ni forma de entrar) y se comparte con la organización (y sus
-- suborganizaciones) con permiso de edición (`share_id`). Sus administradores
-- son invitados con nivel `admin`. Ver `src/server/workspace.ts`.
--
-- `bytes`: su espacio total (sin tope si es nulo). Lo de las suborganizaciones
-- sale de ahí: la suma de lo que se les asigna no puede pasarlo, y el propio
-- espacio de trabajo usa lo que queda. Lo que se sube aquí no cuenta en el
-- espacio personal de nadie.
create table if not exists workspace (
  org_id text primary key references app_org (id) on delete cascade,
  owner_id text not null unique references "user" ("id") on delete cascade,
  root_portfolio_id text not null,
  share_id text not null,
  bytes bigint check (bytes >= 0),
  created_at bigint not null
);
