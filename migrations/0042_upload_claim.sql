-- Uploads into another person's share: who started each object key, through which share and
-- into which portfolio. Only that person may send its parts, finish it and file it there
-- (security finding GRAF-23).
create table if not exists upload_claim (
  key text primary key,
  user_id text not null,
  share_id text not null,
  portfolio_id text,
  created_at bigint not null
);
create index if not exists upload_claim_age on upload_claim (created_at);
