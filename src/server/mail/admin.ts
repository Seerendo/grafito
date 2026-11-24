import type { Sql } from "@/lib/db";

/**
 * Operational figures for administrators: counts, sizes, job and worker state, errors by provider.
 * Nothing here reads a subject, a body, an attachment or a credential; accounts are named by their
 * address and owner so one can be paused.
 */

export type MailStats = {
  users: number;
  accounts: Record<string, number>;
  messages: number;
  bodiesPending: number;
  attachmentsStored: number;
  attachmentBytes: number;
  jobs: {
    queued: number;
    running: number;
    failed24h: number;
    done24h: number;
    avgSyncMs: number;
    oldestQueuedMs: number;
  };
  workers: {
    id: string;
    host: string;
    beatAgoMs: number;
    active: number;
    stats: Record<string, number>;
  }[];
  errorsByProvider: { provider: string; status: string; count: number }[];
  accountList: {
    id: string;
    owner: string;
    email: string;
    provider: string;
    status: string;
    paused: boolean;
    lastSyncAt: number | null;
    lastError: string;
  }[];
};

export async function mailStats(sql: Sql): Promise<MailStats> {
  const now = Date.now();
  const [users] = await sql<{
    n: number;
  }>`select count(distinct user_id)::int as n from mail_account`;
  const statuses = await sql<{
    status: string;
    n: number;
  }>`select status, count(*)::int as n from mail_account group by status`;
  const [messages] = await sql<{ n: number; pending: number }>`
    select count(*)::int as n, count(*) filter (where body_state = 'pending')::int as pending from mail_message
  `;
  const [attachments] = await sql<{ n: number; bytes: number }>`
    select count(*)::int as n, coalesce(sum(size), 0)::bigint as bytes from mail_attachment where download_status = 'ready'
  `;
  const [jobs] = await sql<{
    queued: number;
    running: number;
    failed: number;
    done: number;
    avg: number | null;
    oldest: number | null;
  }>`
    select count(*) filter (where state = 'queued')::int as queued,
      count(*) filter (where state = 'running')::int as running,
      count(*) filter (where state = 'failed' and finished_at > ${now - 86_400_000})::int as failed,
      count(*) filter (where state = 'done' and finished_at > ${now - 86_400_000})::int as done,
      avg(duration_ms) filter (where kind = 'sync' and state = 'done' and finished_at > ${now - 86_400_000}) as avg,
      min(run_after) filter (where state = 'queued' and run_after <= ${now}) as oldest
    from mail_job
  `;
  const workers = await sql<{
    id: string;
    host: string;
    beat_at: unknown;
    active_jobs: number;
    stats: string;
  }>`
    select id, host, beat_at, active_jobs, stats from mail_worker order by beat_at desc limit 20
  `;
  const errors = await sql<{ provider: string; status: string; n: number }>`
    select provider, status, count(*)::int as n from mail_account
    where status in ('auth_error', 'expired', 'connection_error', 'error', 'retrying')
    group by provider, status order by provider, status
  `;
  const accounts = await sql<{
    id: string;
    login_name: string | null;
    email: string;
    provider: string;
    status: string;
    admin_paused: unknown;
    last_sync_at: unknown;
    last_error: string;
  }>`
    select a.id, r.login_name, a.email, a.provider, a.status, a.admin_paused, a.last_sync_at, a.last_error
    from mail_account a left join app_user_role r on r.user_id = a.user_id
    order by a.status <> 'ok', a.last_sync_at nulls first limit 200
  `;
  return {
    users: users?.n ?? 0,
    accounts: Object.fromEntries(statuses.map((row) => [row.status, row.n])),
    messages: messages?.n ?? 0,
    bodiesPending: messages?.pending ?? 0,
    attachmentsStored: attachments?.n ?? 0,
    attachmentBytes: Number(attachments?.bytes ?? 0),
    jobs: {
      queued: jobs?.queued ?? 0,
      running: jobs?.running ?? 0,
      failed24h: jobs?.failed ?? 0,
      done24h: jobs?.done ?? 0,
      avgSyncMs: Math.round(Number(jobs?.avg ?? 0)),
      oldestQueuedMs: jobs?.oldest ? now - Number(jobs.oldest) : 0,
    },
    workers: workers.map((row) => {
      let stats: Record<string, number> = {};
      try {
        stats = JSON.parse(row.stats) as Record<string, number>;
      } catch {
        /* none yet */
      }
      return {
        id: row.id,
        host: row.host,
        beatAgoMs: now - Number(row.beat_at),
        active: Number(row.active_jobs),
        stats,
      };
    }),
    errorsByProvider: errors.map((row) => ({
      provider: row.provider,
      status: row.status,
      count: row.n,
    })),
    accountList: accounts.map((row) => ({
      id: row.id,
      owner: row.login_name ?? "",
      email: row.email,
      provider: row.provider,
      status: row.status,
      paused: row.admin_paused === true || row.admin_paused === "t",
      lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
      lastError: row.last_error,
    })),
  };
}

export async function pauseAccount(sql: Sql, id: string, paused: boolean): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    update mail_account set admin_paused = ${paused}, status = case when ${paused} then 'paused' else 'connected' end,
      next_sync_at = case when ${paused} then next_sync_at else ${Date.now()} end, updated_at = ${Date.now()}
    where id = ${id} returning id
  `;
  return Boolean(rows[0]);
}

/** Failed jobs of the last day go back to the queue (not wrong-credential ones: those need the owner). */
export async function retryFailed(sql: Sql): Promise<number> {
  const now = Date.now();
  const rows = await sql<{ id: string }>`
    update mail_job set state = 'queued', attempts = 0, run_after = ${now}, updated_at = ${now}
    where state = 'failed' and finished_at > ${now - 86_400_000}
      and account_id in (select id from mail_account where status not in ('auth_error', 'expired', 'disconnected', 'deleting'))
      and not exists (select 1 from mail_job q where q.dedupe_key = mail_job.dedupe_key and q.state in ('queued', 'running'))
    returning id
  `;
  await sql`select pg_notify('mail_job', 'retry')`.catch(() => undefined);
  return rows.length;
}
