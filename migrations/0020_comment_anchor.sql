-- Notas sobre una frase de un PDF: un comentario con su ancla (la frase, la
-- página y el contexto, como los vínculos; ver `domain/vault/anchor.ts`), en
-- JSON. Sin ancla, es un comentario del documento entero.
alter table doc_comment add column if not exists anchor text;
