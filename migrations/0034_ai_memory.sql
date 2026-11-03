-- Memoria comprimida de cada conversación: lo ya hablado, para no reenviar
-- el historial entero en cada mensaje. `memory_until` es el id del último
-- turno que ya entra en ese resumen.
alter table ai_conversation add column if not exists memory text not null default '';
alter table ai_conversation add column if not exists memory_until text not null default '';
