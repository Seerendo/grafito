import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";

/**
 * The mail-sync job queue, in Postgres. A job with the same dedupe key is not queued twice while
 * one is waiting or running (a double click, a scheduler tick and a manual sync collapse into one).
 * Workers claim with FOR UPDATE SKIP LOCKED and a lease; a worker that dies leaves a lease that
 * expires, and the job is claimed again. One sync per account runs at a time (the account lease),
 * and attachment downloads use a lease of their own so opening one never waits for a sync.
 */

export type MailJobKind = "sync" | "attachment" | "eml" | "cleanup" | "test" | "flags";

/** Jobs that hold the account's second lease, so they run beside a long sync. */
export function onFetchLane(kind: MailJobKind | string): boolean {
  return kind === "attachment" || kind === "eml" || kind === "flags";
}

export const JOB_LEASE_MS = 3 * 60 * 1000;

export async function enqueue(
  sql: Sql,
  input: {
    userId: string;
    accountId: string;
    kind: MailJobKind;
    payload?: Record<string, unknown>;
    dedupe?: string;
    priority?: number;
    runAfter?: number;
  },
): Promise<string | null> {
  const now = Date.now();
  const id = randomUUID();
  const rows = await sql<{ id: string }>`
    insert into mail_job (id, user_id, account_id, kind, payload, dedupe_key, priority, run_after, created_at, updated_at)
    values (${id}, ${input.userId}, ${input.accountId}, ${input.kind}, ${JSON.stringify(input.payload ?? {})},
      ${input.dedupe ?? `${input.kind}:${input.accountId}`}, ${input.priority ?? 0}, ${input.runAfter ?? now}, ${now}, ${now})
    on conflict (dedupe_key) where state in ('queued', 'running') do nothing
    returning id
  `;
  // Wake a listening worker; polling still finds the job if nobody listens.
  await sql`select pg_notify('mail_job', ${input.kind})`.catch(() => undefined);
  return rows[0]?.id ?? null;
}

export type ClaimedJob = {
  id: string;
  userId: string;
  accountId: string;
  kind: MailJobKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  provider: string;
};

/**
 * Claim the next job this worker may run: due, of an account nobody else is syncing, of a
 * provider under its limit, oldest first among equal priority (so a big mailbox that requeues
 * itself goes behind the others).
 */
export async function claim(
  sql: Sql,
  input: { worker: string; providerLimit: number; pausedProviders: string[]; kinds: MailJobKind[] },
): Promise<ClaimedJob | null> {
  const now = Date.now();
  const paused = input.pausedProviders.join(",");
  const kinds = input.kinds.join(",");
  // Expired leases go back to the queue first.
  await sql`
    update mail_job set state = 'queued', lease_owner = null, lease_until = null, updated_at = ${now}
    where state = 'running' and lease_until < ${now}
  `;
  const candidates = await sql<{ id: string; account_id: string; kind: string; provider: string }>`
    select j.id, j.account_id, j.kind, a.provider from mail_job j
    join mail_account a on a.id = j.account_id
    where j.state = 'queued' and j.run_after <= ${now}
      and j.kind = any(string_to_array(${kinds}, ','))
      and not (a.provider = any(string_to_array(${paused}, ',')))
      and (select count(*) from mail_job r join mail_account ra on ra.id = r.account_id
           where r.state = 'running' and ra.provider = a.provider) < ${input.providerLimit}
    order by j.priority desc, j.run_after, j.created_at
    limit 20
  `;
  for (const candidate of candidates) {
    // The account lease: sync jobs and downloads each hold their own.
    const download = onFetchLane(candidate.kind);
    const leased = download
      ? await sql<{ id: string }>`
          update mail_account set fetch_lease_owner = ${input.worker}, fetch_lease_until = ${now + JOB_LEASE_MS}
          where id = ${candidate.account_id} and (fetch_lease_until is null or fetch_lease_until < ${now} or fetch_lease_owner = ${input.worker})
          returning id`
      : await sql<{ id: string }>`
          update mail_account set lease_owner = ${input.worker}, lease_until = ${now + JOB_LEASE_MS}
          where id = ${candidate.account_id} and (lease_until is null or lease_until < ${now})
          returning id`;
    if (!leased[0]) continue;
    const rows = await sql<{
      id: string;
      user_id: string;
      account_id: string;
      kind: MailJobKind;
      payload: string;
      attempts: number;
      max_attempts: number;
    }>`
      update mail_job set state = 'running', lease_owner = ${input.worker}, lease_until = ${now + JOB_LEASE_MS},
        attempts = attempts + 1, updated_at = ${now}
      where id = (select id from mail_job where id = ${candidate.id} and state = 'queued' for update skip locked)
      returning id, user_id, account_id, kind, payload, attempts, max_attempts
    `;
    const row = rows[0];
    if (!row) {
      await releaseAccount(sql, candidate.account_id, input.worker, download);
      continue;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      /* an unreadable payload runs with none */
    }
    return {
      id: row.id,
      userId: row.user_id,
      accountId: row.account_id,
      kind: row.kind,
      payload,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      provider: candidate.provider,
    };
  }
  return null;
}

export async function releaseAccount(
  sql: Sql,
  accountId: string,
  worker: string,
  download: boolean,
): Promise<void> {
  if (download)
    await sql`update mail_account set fetch_lease_owner = null, fetch_lease_until = null where id = ${accountId} and fetch_lease_owner = ${worker}`;
  else
    await sql`update mail_account set lease_owner = null, lease_until = null where id = ${accountId} and lease_owner = ${worker}`;
}

/** Keep a long job's leases alive. */
export async function extendLease(sql: Sql, job: ClaimedJob, worker: string): Promise<void> {
  const until = Date.now() + JOB_LEASE_MS;
  await sql`update mail_job set lease_until = ${until} where id = ${job.id} and lease_owner = ${worker}`;
  if (onFetchLane(job.kind))
    await sql`update mail_account set fetch_lease_until = ${until} where id = ${job.accountId} and fetch_lease_owner = ${worker}`;
  else
    await sql`update mail_account set lease_until = ${until} where id = ${job.accountId} and lease_owner = ${worker}`;
}

export async function finish(
  sql: Sql,
  job: ClaimedJob,
  worker: string,
  outcome: { state: "done" | "failed" | "cancelled"; error?: string; durationMs: number },
): Promise<void> {
  const now = Date.now();
  await sql`
    update mail_job set state = ${outcome.state}, last_error = ${(outcome.error ?? "").slice(0, 500)},
      finished_at = ${now}, duration_ms = ${outcome.durationMs}, lease_owner = null, lease_until = null, updated_at = ${now}
    where id = ${job.id} and lease_owner = ${worker}
  `;
  await releaseAccount(sql, job.accountId, worker, onFetchLane(job.kind));
}

/** Put a job back for later (a retry after backoff, or the next slice of a long sync). */
export async function requeue(
  sql: Sql,
  job: ClaimedJob,
  worker: string,
  input: { runAfter: number; error?: string; resetAttempts?: boolean; priority?: number },
): Promise<void> {
  const now = Date.now();
  await sql`
    update mail_job set state = 'queued', run_after = ${input.runAfter}, last_error = ${(input.error ?? "").slice(0, 500)},
      attempts = case when ${input.resetAttempts ?? false} then 0 else attempts end,
      priority = coalesce(${input.priority ?? null}, priority),
      lease_owner = null, lease_until = null, updated_at = ${now}
    where id = ${job.id} and lease_owner = ${worker}
  `;
  await releaseAccount(sql, job.accountId, worker, onFetchLane(job.kind));
  await sql`select pg_notify('mail_job', 'requeue')`.catch(() => undefined);
}

/** Old finished jobs are removed after a week; their counts stay in the admin statistics until then. */
export async function sweepJobs(sql: Sql): Promise<void> {
  await sql`delete from mail_job where state in ('done', 'cancelled', 'failed') and finished_at < ${Date.now() - 7 * 86_400_000}`;
}
