-- Conversaciones del chat de IA de cada usuario (historial del chat). Los
-- turnos se guardan como JSON en texto: solo los lee y escribe el propio chat.
create table if not exists ai_conversation (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  title text not null default '',
  turns text not null default '[]',
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists ai_conversation_user_updated on ai_conversation (user_id, updated_at desc);
