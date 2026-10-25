-- Ollama y LM Studio: cada persona conecta su propia instancia. El
-- administrador solo decide si se pueden usar; la dirección es de cada usuario.
alter table ai_credential add column if not exists base_url text not null default '';
alter table ai_provider drop column if exists base_url;
