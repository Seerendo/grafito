-- Compressed conversation memory avoids resending full history. memory_until identifies the last
-- turn included in the summary.
alter table ai_conversation add column if not exists memory text not null default '';
alter table ai_conversation add column if not exists memory_until text not null default '';
