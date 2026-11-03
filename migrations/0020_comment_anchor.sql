-- PDF phrase comments store a JSON anchor with phrase, page and context; see
-- domain/vault/anchor.ts. Without an anchor, a comment applies to the whole document.
alter table doc_comment add column if not exists anchor text;
