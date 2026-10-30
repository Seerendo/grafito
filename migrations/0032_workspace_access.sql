-- Acceso de cada persona a un portafolio de un espacio de trabajo.
-- Sin fila, el miembro ve el espacio pero no lo que hay dentro.
-- El administrador lo concede (y puede replicarlo en los portafolios de dentro).

create table if not exists workspace_access (
  owner_id text not null,
  portfolio_id text not null,
  user_id text not null,
  access text not null check (access in ('read', 'edit')),
  primary key (owner_id, portfolio_id, user_id)
);

create index if not exists workspace_access_user on workspace_access (owner_id, user_id);

-- La organización deja de heredar edición: solo el administrador (concesión
-- directa) edita todo. Lo de dentro se concede aparte.
update share_item set access = 'read'
where id in (select share_id from workspace) and access = 'edit';
