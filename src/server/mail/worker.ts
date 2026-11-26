import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import type { Sql } from "@/lib/db";
import { backoffMs, type MailPolicy } from "@/domain/mail/policy";
import { safeFileName } from "@/domain/mail/message";
import {
  abortUpload,
  deleteBlob,
  finishUpload,
  PART_SIZE,
  putBlob,
  startUpload,
  uploadPart,
} from "@/server/blobs";
import { blockUnsafeBlob, readClamavSettings } from "@/server/clamav";
import { newFileKey } from "@/server/files";
import { claimJob } from "@/server/jobs";
import { checkSpace } from "@/server/space";
import { uploadTarget } from "@/server/upload-target";
import { registerImportedDoc } from "@/server/vault";
import { logEvent } from "@/server/telemetry";
import { buildConnector, connectorAccount, storeTokens } from "./accounts";
import { MailError, type SyncContext } from "./providers/types";
import { claim, enqueue, extendLease, finish, requeue, sweepJobs, type ClaimedJob } from "./queue";
import { readMailPolicy } from "./settings";
import {
  localUids,
  readState,
  refreshCounts,
  resetFolder,
  saveMessages,
  updateFlags,
  upsertFolders,
  vanishMessages,
  vanishUids,
  writeState,
} from "./store";

/**
 * The mail-sync worker (a process of its own, src/mail-worker/main.ts). It never serves HTTP:
 * it claims jobs, runs each in a bounded slice (at most SLICE_MS and MAX_MESSAGES, then the job
 * goes back behind the others), schedules accounts that are due, and writes a heartbeat the web
 * app reads to know the module is connected. Several workers can run side by side.
 */

const SLICE_MS = Number(process.env.MAIL_SYNC_SLICE_SECONDS || 25) * 1000;
const MAX_MESSAGES = Number(process.env.MAIL_SYNC_BATCH || 400);
const POLL_MS = 2000;
const BEAT_MS = 10_000;
const BEAT_FILE = "/tmp/mail-sync-beat";
const GC_MS = 7 * 86_400_000;

type Stats = {
  processed: number;
  jobs: number;
  failures: number;
  authErrors: number;
  connectionErrors: number;
  rateLimited: number;
  syncMs: number;
};

/** A failure of file storage (MinIO down) is temporary and says so, instead of "unexpected". */
async function storage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailError) throw error;
    throw new MailError(
      "temporary",
      "El almacenamiento de archivos no responde. Inténtalo en un momento.",
    );
  }
}

export class MailWorker {
  readonly id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private running = true;
  private active = new Map<string, Promise<void>>();
  private wake: (() => void) | null = null;
  private stats: Stats = {
    processed: 0,
    jobs: 0,
    failures: 0,
    authErrors: 0,
    connectionErrors: 0,
    rateLimited: 0,
    syncMs: 0,
  };

  constructor(
    private readonly sql: Sql,
    private readonly concurrencyOverride: number | null,
  ) {}

  /** A NOTIFY or a finished job: look for work now instead of at the next poll. */
  nudge(): void {
    this.wake?.();
  }

  async start(): Promise<void> {
    const now = Date.now();
    await this.sql`
      insert into mail_worker (id, host, started_at, beat_at) values (${this.id}, ${hostname()}, ${now}, ${now})
    `;
    logEvent("mail.worker.start", { worker: this.id });
    const beat = setInterval(() => void this.beat(), BEAT_MS);
    const schedule = setInterval(
      () => void this.schedule().catch((error) => this.fail("schedule", error)),
      30_000,
    );
    void this.beat();
    void this.schedule().catch((error) => this.fail("schedule", error));
    try {
      while (this.running) {
        await this.fill();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_MS);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    } finally {
      clearInterval(beat);
      clearInterval(schedule);
    }
  }

  /** Stop claiming, let running jobs finish their slice, and leave. */
  async stop(): Promise<void> {
    this.running = false;
    this.nudge();
    const deadline = Date.now() + 20_000;
    while (this.active.size > 0 && Date.now() < deadline)
      await Promise.race([...this.active.values(), new Promise((r) => setTimeout(r, 500))]);
    // Whatever is still running goes back to the queue for another worker.
    await this.sql`
      update mail_job set state = 'queued', lease_owner = null, lease_until = null, run_after = ${Date.now()}
      where lease_owner = ${this.id} and state = 'running'
    `.catch(() => undefined);
    await this
      .sql`update mail_account set lease_owner = null, lease_until = null where lease_owner = ${this.id}`.catch(
      () => undefined,
    );
    await this
      .sql`update mail_account set fetch_lease_owner = null, fetch_lease_until = null where fetch_lease_owner = ${this.id}`.catch(
      () => undefined,
    );
    await this.sql`delete from mail_worker where id = ${this.id}`.catch(() => undefined);
    logEvent("mail.worker.stop", { worker: this.id });
  }

  private fail(where: string, error: unknown) {
    logEvent("mail.worker.error", {
      worker: this.id,
      where,
      error: error instanceof Error ? error.message.slice(0, 200) : "?",
    });
  }

  private async beat(): Promise<void> {
    try {
      const memory = process.memoryUsage();
      await this.sql`
        update mail_worker set beat_at = ${Date.now()}, active_jobs = ${this.active.size},
          stats = ${JSON.stringify({ ...this.stats, rss: memory.rss, heap: memory.heapUsed })}
        where id = ${this.id}
      `;
      await this.sql`delete from mail_worker where beat_at < ${Date.now() - 86_400_000}`;
      await writeFile(BEAT_FILE, String(Date.now())).catch(() => undefined);
    } catch (error) {
      this.fail("beat", error);
    }
  }

  /** Queue a sync for every account that is due (one worker does this per pass). */
  private async schedule(): Promise<void> {
    if (!(await claimJob(this.sql, "mail-scheduler", 25_000))) return;
    const policy = await readMailPolicy(this.sql);
    const now = Date.now();
    if (!policy.paused) {
      const due = await this.sql<{ id: string; user_id: string }>`
        select id, user_id from mail_account
        where sync_enabled and secret <> ''
          and status not in ('auth_error', 'expired', 'disconnected', 'deleting')
          and (next_sync_at is null or next_sync_at <= ${now})
          and not (provider = any(string_to_array(${policy.pausedProviders.join(",")}, ',')))
        order by next_sync_at nulls first limit 500
      `;
      for (const account of due)
        await enqueue(this.sql, { userId: account.user_id, accountId: account.id, kind: "sync" });
    }
    // Messages gone from every folder for a week are removed with their downloaded attachments.
    if (await claimJob(this.sql, "mail-gc", 60 * 60 * 1000)) await this.collect(now);
    await sweepJobs(this.sql);
  }

  private async collect(now: number): Promise<void> {
    const gone = await this.sql<{ id: string }>`
      select m.id from mail_message m
      where m.updated_at < ${now - GC_MS}
        and not exists (select 1 from mail_message_location l where l.message_id = m.id and l.deleted_at is null)
        and exists (select 1 from mail_message_location l where l.message_id = m.id)
      limit 500
    `;
    for (const message of gone) {
      const blobs = await this.sql<{ storage_key: string }>`
        select storage_key from mail_attachment where message_id = ${message.id} and storage_key is not null
      `;
      for (const blob of blobs) await deleteBlob(this.sql, blob.storage_key).catch(() => undefined);
      await this.sql`delete from mail_message where id = ${message.id}`;
    }
    if (gone.length) logEvent("mail.gc", { worker: this.id, messages: gone.length });
  }

  private async fill(): Promise<void> {
    const policy = await readMailPolicy(this.sql);
    const limit = this.concurrencyOverride ?? policy.concurrency;
    while (this.running && this.active.size < limit) {
      const kinds = policy.paused
        ? (["attachment", "eml", "cleanup"] as const)
        : (["sync", "attachment", "eml", "cleanup", "flags", "delete"] as const);
      const job = await claim(this.sql, {
        worker: this.id,
        providerLimit: policy.providerConcurrency,
        pausedProviders: policy.pausedProviders,
        kinds: [...kinds],
      });
      if (!job) return;
      const run = this.run(job, policy).finally(() => {
        this.active.delete(job.id);
        this.nudge();
      });
      this.active.set(job.id, run);
    }
  }

  private async run(job: ClaimedJob, policy: MailPolicy): Promise<void> {
    const started = Date.now();
    const keepAlive = setInterval(
      () => void extendLease(this.sql, job, this.id).catch(() => undefined),
      60_000,
    );
    try {
      if (job.kind === "sync") await this.sync(job, policy, started);
      else if (job.kind === "attachment") await this.attachment(job, policy, started);
      else if (job.kind === "eml") await this.eml(job, policy, started);
      else if (job.kind === "flags") await this.flags(job, started);
      else if (job.kind === "delete") await this.remove(job, started);
      else if (job.kind === "cleanup") await this.cleanup(job, started);
      else await finish(this.sql, job, this.id, { state: "cancelled", durationMs: 0 });
      this.stats.jobs += 1;
    } catch (error) {
      await this.failed(job, error, started);
    } finally {
      clearInterval(keepAlive);
    }
  }

  private async failed(job: ClaimedJob, error: unknown, started: number): Promise<void> {
    const mail =
      error instanceof MailError ? error : new MailError("temporary", "Error inesperado.");
    if (!(error instanceof MailError)) this.fail(`job:${job.kind}`, error);
    this.stats.failures += 1;
    if (mail.kind === "auth" || mail.kind === "expired") this.stats.authErrors += 1;
    if (mail.kind === "connection") this.stats.connectionErrors += 1;
    if (mail.kind === "rate_limited") this.stats.rateLimited += 1;
    const now = Date.now();
    logEvent("mail.job.error", {
      worker: this.id,
      job: job.id,
      account: job.accountId,
      kind: job.kind,
      error: mail.kind,
      attempt: job.attempts,
    });
    if (job.kind === "eml" || job.kind === "flags" || job.kind === "delete") {
      const retry =
        mail.kind === "connection" || mail.kind === "temporary" || mail.kind === "rate_limited";
      if (retry && job.attempts < 4) {
        await requeue(this.sql, job, this.id, {
          runAfter: now + backoffMs(job.attempts, Math.random(), mail.retryAfterMs, 5_000, 120_000),
          error: mail.message,
        });
        return;
      }
      // Not deleted on the server: the message shows again where it was.
      if (job.kind === "delete")
        await this.sql`update mail_message_location set deleted_at = null
          where message_id = ${String(job.payload.messageId ?? "")} and deleted_at = ${Number(job.payload.at ?? -1)}`;
      await finish(this.sql, job, this.id, {
        state: "failed",
        error: mail.message,
        durationMs: now - started,
      });
      return;
    }
    if (job.kind === "attachment") {
      const id = String(job.payload.attachmentId ?? "");
      const retry =
        mail.kind === "connection" || mail.kind === "temporary" || mail.kind === "rate_limited";
      if (retry && job.attempts < 4) {
        await requeue(this.sql, job, this.id, {
          runAfter: now + backoffMs(job.attempts, Math.random(), mail.retryAfterMs, 5_000, 120_000),
          error: mail.message,
        });
        return;
      }
      await this
        .sql`update mail_attachment set download_status = 'failed', error = ${mail.message.slice(0, 300)}, updated_at = ${now} where id = ${id}`;
      await finish(this.sql, job, this.id, {
        state: "failed",
        error: mail.message,
        durationMs: now - started,
      });
      return;
    }
    const permanent = mail.kind === "auth" || mail.kind === "expired" || mail.kind === "permanent";
    const status =
      mail.kind === "auth"
        ? "auth_error"
        : mail.kind === "expired"
          ? "expired"
          : mail.kind === "permanent"
            ? "error"
            : "retrying";
    if (!permanent && job.attempts < job.maxAttempts) {
      const wait = backoffMs(job.attempts, Math.random(), mail.retryAfterMs);
      await this.sql`
        update mail_account set status = 'retrying', status_detail = ${String(now + wait)}, last_error = ${mail.message.slice(0, 300)},
          consecutive_failures = consecutive_failures + 1, updated_at = ${now}
        where id = ${job.accountId}
      `;
      await requeue(this.sql, job, this.id, { runAfter: now + wait, error: mail.message });
      return;
    }
    // Wrong credentials are not retried until the person acts; other failures wait for the schedule.
    const next = permanent ? null : now + 15 * 60 * 1000;
    await this.sql`
      update mail_account set status = ${permanent ? status : "connection_error"}, status_detail = '',
        last_error = ${mail.message.slice(0, 300)}, consecutive_failures = consecutive_failures + 1,
        next_sync_at = ${next}, updated_at = ${now}
      where id = ${job.accountId}
    `;
    await finish(this.sql, job, this.id, {
      state: "failed",
      error: mail.message,
      durationMs: now - started,
    });
  }

  private async sync(job: ClaimedJob, policy: MailPolicy, started: number): Promise<void> {
    const account = await connectorAccount(this.sql, job.accountId);
    if (!account || !account.secret) {
      await finish(this.sql, job, this.id, { state: "cancelled", durationMs: 0 });
      return;
    }
    const scope = { id: account.id, userId: account.userId };
    await this
      .sql`update mail_account set status = 'syncing', updated_at = ${Date.now()} where id = ${account.id}`;
    let folderIds = new Map<string, string>();
    const context: SyncContext = {
      policy,
      deadline: started + SLICE_MS,
      maxMessages: MAX_MESSAGES,
      folders: async (remote) => {
        const map = await upsertFolders(this.sql, scope, remote);
        folderIds = new Map([...map].map(([remoteId, item]) => [remoteId, item.id]));
        return map;
      },
      state: (folderId) => readState(this.sql, account.id, folderId),
      saveState: (folderId, state) => writeState(this.sql, scope, folderId, state),
      saveMessages: (messages) => saveMessages(this.sql, scope, folderIds, messages, policy),
      updateFlags: (folderId, items) => updateFlags(this.sql, folderId, items),
      vanishUids: (folderId, validity, uids) => vanishUids(this.sql, folderId, validity, uids),
      vanishMessages: (folderId, ids) => vanishMessages(this.sql, account.id, folderId, ids),
      resetFolder: (folderId) => resetFolder(this.sql, folderId),
      localUids: (folderId, validity) => localUids(this.sql, folderId, validity),
      progress: async ({ phase }) => {
        await this
          .sql`update mail_account set sync_phase = ${phase}, updated_at = ${Date.now()} where id = ${account.id}`;
      },
      saveTokens: (secret) => storeTokens(this.sql, account.id, secret),
    };
    const connector = await buildConnector(this.sql, account);
    let result;
    try {
      result = await connector.sync(context);
    } finally {
      await connector.close();
    }
    await refreshCounts(this.sql, account.id);
    const pending = await this.sql<{ n: number }>`
      select count(*)::int as n from mail_sync_state where account_id = ${account.id} and not backfill_done
    `;
    const phase = (pending[0]?.n ?? 0) > 0 || result.more ? "initial" : "incremental";
    const now = Date.now();
    const interval = await this.sql<{
      s: number;
    }>`select sync_interval_seconds as s from mail_account where id = ${account.id}`;
    const next = now + Number(interval[0]?.s ?? policy.defaultIntervalSeconds) * 1000;
    this.stats.processed += result.processed;
    this.stats.syncMs += now - started;
    logEvent("mail.sync", {
      worker: this.id,
      job: job.id,
      account: account.id,
      processed: result.processed,
      more: result.more,
      ms: now - started,
    });
    await this.sql`
      update mail_account set status = ${result.more ? "syncing" : "ok"}, status_detail = '', last_error = '',
        consecutive_failures = 0, sync_phase = ${phase}, last_sync_at = ${now}, next_sync_at = ${next}, updated_at = ${now}
      where id = ${account.id} and status <> 'deleting'
    `;
    if (result.more) {
      // The next slice waits behind other accounts' jobs (lower priority, queued now).
      await requeue(this.sql, job, this.id, { runAfter: now, resetAttempts: true, priority: -1 });
      return;
    }
    await finish(this.sql, job, this.id, { state: "done", durationMs: now - started });
  }

  /** Download one attachment into storage, scan it, and record the result. */
  private async attachment(job: ClaimedJob, policy: MailPolicy, started: number): Promise<void> {
    const attachmentId = String(job.payload.attachmentId ?? "");
    const rows = await this.sql<{
      id: string;
      user_id: string;
      account_id: string;
      provider_attachment_id: string;
      content_type: string;
      size: number;
      download_status: string;
      provider_message_id: string;
      remote_uid: unknown;
      remote_id: string | null;
    }>`
      select a.id, a.user_id, a.account_id, a.provider_attachment_id, a.content_type, a.size, a.download_status,
        m.provider_message_id, l.remote_uid, f.remote_id
      from mail_attachment a
      join mail_message m on m.id = a.message_id
      left join mail_message_location l on l.message_id = m.id and l.deleted_at is null
      left join mail_folder f on f.id = l.folder_id
      where a.id = ${attachmentId} and a.account_id = ${job.accountId}
      limit 1
    `;
    const row = rows[0];
    if (!row || row.download_status === "ready" || row.download_status === "blocked") {
      await finish(this.sql, job, this.id, { state: "done", durationMs: 0 });
      return;
    }
    if (Number(row.size) > policy.maxAttachmentBytes * 1.4) {
      await this
        .sql`update mail_attachment set download_status = 'too_large', updated_at = ${Date.now()} where id = ${row.id}`;
      await finish(this.sql, job, this.id, { state: "done", durationMs: 0 });
      return;
    }
    if (policy.attachmentQuotaBytes > 0) {
      const used = await this.sql<{ n: number }>`
        select coalesce(sum(size), 0)::bigint as n from mail_attachment where user_id = ${row.user_id} and download_status = 'ready'
      `;
      if (Number(used[0]?.n ?? 0) + Number(row.size) > policy.attachmentQuotaBytes) {
        await this
          .sql`update mail_attachment set download_status = 'failed', error = 'Se alcanzó el espacio para adjuntos.', updated_at = ${Date.now()} where id = ${row.id}`;
        await finish(this.sql, job, this.id, { state: "failed", error: "quota", durationMs: 0 });
        return;
      }
    }
    const account = await connectorAccount(this.sql, row.account_id);
    if (!account?.secret) throw new MailError("auth", "La cuenta está desconectada.");
    await this
      .sql`update mail_attachment set download_status = 'downloading', error = '', updated_at = ${Date.now()} where id = ${row.id}`;
    const key = `mail/${row.user_id}/${row.account_id}/${row.id}`;
    const uploadId = await storage(() =>
      startUpload(this.sql, key, row.content_type || "application/octet-stream"),
    );
    const hash = createHash("sha256");
    const parts: { part: number; etag: string }[] = [];
    let buffer: Uint8Array[] = [];
    let buffered = 0;
    const flush = async () => {
      const bytes = Buffer.concat(buffer);
      buffer = [];
      buffered = 0;
      parts.push({
        part: parts.length + 1,
        etag: await storage(() => uploadPart(this.sql, key, uploadId, parts.length + 1, bytes)),
      });
    };
    const connector = await buildConnector(this.sql, account);
    let total = 0;
    try {
      total = await connector.fetchAttachment(
        {
          providerMessageId: row.provider_message_id,
          uid: row.remote_uid == null ? null : Number(row.remote_uid),
          folderRemoteId: row.remote_id,
        },
        { providerAttachmentId: row.provider_attachment_id },
        {
          write: async (chunk) => {
            hash.update(chunk);
            buffer.push(chunk);
            buffered += chunk.byteLength;
            if (buffered >= PART_SIZE) await flush();
          },
        },
        policy.maxAttachmentBytes,
      );
      if (buffered > 0 || parts.length === 0) await flush();
      await storage(() => finishUpload(this.sql, key, uploadId, parts));
    } catch (error) {
      await abortUpload(this.sql, key, uploadId).catch(() => undefined);
      await deleteBlob(this.sql, key).catch(() => undefined);
      throw error;
    } finally {
      await connector.close();
    }
    // A failure of the antivirus is not a clean result: the file is refused.
    const clam = await readClamavSettings(this.sql);
    const blocked = await blockUnsafeBlob(this.sql, key);
    const now = Date.now();
    if (blocked) {
      const infected = blocked.status === 422;
      await this.sql`
        update mail_attachment set download_status = 'blocked', antivirus_status = ${infected ? "infected" : "error"},
          storage_key = null, error = ${blocked.message.slice(0, 300)}, updated_at = ${now}
        where id = ${row.id}
      `;
      logEvent("mail.attachment.blocked", { worker: this.id, attachment: row.id, infected });
      await finish(this.sql, job, this.id, { state: "done", durationMs: now - started });
      return;
    }
    await this.sql`
      update mail_attachment set download_status = 'ready', antivirus_status = ${clam.enabled ? "clean" : "off"},
        storage_key = ${key}, checksum = ${hash.digest("hex")}, size = ${total}, error = '', updated_at = ${now}
      where id = ${row.id}
    `;
    logEvent("mail.attachment", {
      worker: this.id,
      attachment: row.id,
      bytes: total,
      ms: now - started,
    });
    await finish(this.sql, job, this.id, { state: "done", durationMs: now - started });
  }

  /**
   * Write a message's read and flagged state to the server. The values are read now (the latest
   * the person chose, even after several clicks); once the server has them they are the
   * server's, so a later change made in another client shows in Grafito.
   */
  private async flags(job: ClaimedJob, started: number): Promise<void> {
    const messageId = String(job.payload.messageId ?? "");
    const rows = await this.sql<{
      provider_message_id: string;
      local_seen: unknown;
      local_flagged: unknown;
      remote_seen: unknown;
      remote_flagged: unknown;
    }>`
      select provider_message_id, local_seen, local_flagged, remote_seen, remote_flagged
      from mail_message where id = ${messageId} and account_id = ${job.accountId} limit 1
    `;
    const message = rows[0];
    const bool = (value: unknown) => (value == null ? null : value === true || value === "t");
    const seen = bool(message?.local_seen);
    const flagged = bool(message?.local_flagged);
    const changes = {
      ...(seen !== null && seen !== bool(message?.remote_seen) ? { seen } : {}),
      ...(flagged !== null && flagged !== bool(message?.remote_flagged) ? { flagged } : {}),
    };
    if (!message || Object.keys(changes).length === 0) {
      if (message)
        await this
          .sql`update mail_message set local_seen = null, local_flagged = null where id = ${messageId}
          and local_seen is not distinct from ${seen} and local_flagged is not distinct from ${flagged}`;
      await finish(this.sql, job, this.id, { state: "done", durationMs: Date.now() - started });
      return;
    }
    const locations = await this.sql<{ remote_id: string; remote_uid: unknown }>`
      select f.remote_id, l.remote_uid from mail_message_location l join mail_folder f on f.id = l.folder_id
      where l.message_id = ${messageId} and l.deleted_at is null and l.remote_uid is not null
    `;
    const account = await connectorAccount(this.sql, job.accountId);
    if (!account?.secret) throw new MailError("auth", "La cuenta está desconectada.");
    const connector = await buildConnector(this.sql, account);
    try {
      await connector.setFlags(
        {
          providerMessageId: message.provider_message_id,
          locations: locations.map((row) => ({
            folderRemoteId: row.remote_id,
            uid: Number(row.remote_uid),
          })),
        },
        changes,
      );
    } finally {
      await connector.close();
    }
    // The server holds them now; a later click while this ran keeps its own local value.
    await this.sql`
      update mail_message set
        remote_seen = coalesce(${changes.seen ?? null}, remote_seen),
        remote_flagged = coalesce(${changes.flagged ?? null}, remote_flagged),
        local_seen = case when local_seen is not distinct from ${seen} then null else local_seen end,
        local_flagged = case when local_flagged is not distinct from ${flagged} then null else local_flagged end,
        updated_at = ${Date.now()}
      where id = ${messageId}
    `;
    await finish(this.sql, job, this.id, { state: "done", durationMs: Date.now() - started });
  }

  /**
   * Delete a message on the server: into its trash, or for good when it was in the trash. Its
   * places were marked gone when the person deleted it (deleted_at = the payload's "at"); the
   * copy in the trash arrives with the sync that follows.
   */
  private async remove(job: ClaimedJob, started: number): Promise<void> {
    const messageId = String(job.payload.messageId ?? "");
    const at = Number(job.payload.at ?? -1);
    const rows = await this.sql<{ provider_message_id: string }>`
      select provider_message_id from mail_message where id = ${messageId} and account_id = ${job.accountId} limit 1
    `;
    const locations = await this.sql<{
      remote_id: string;
      remote_uid: unknown;
      special_use: string;
    }>`
      select f.remote_id, l.remote_uid, f.special_use from mail_message_location l
      join mail_folder f on f.id = l.folder_id
      where l.message_id = ${messageId} and l.deleted_at = ${at}
    `;
    if (!rows[0] || locations.length === 0) {
      await finish(this.sql, job, this.id, { state: "done", durationMs: Date.now() - started });
      return;
    }
    const trash = await this.sql<{ remote_id: string }>`
      select remote_id from mail_folder where account_id = ${job.accountId} and special_use = 'trash'
        and not removed order by path limit 1
    `;
    const account = await connectorAccount(this.sql, job.accountId);
    if (!account?.secret) throw new MailError("auth", "La cuenta está desconectada.");
    const connector = await buildConnector(this.sql, account);
    try {
      await connector.deleteMessage(
        {
          providerMessageId: rows[0].provider_message_id,
          locations: locations
            .filter((row) => row.remote_uid != null)
            .map((row) => ({ folderRemoteId: row.remote_id, uid: Number(row.remote_uid) })),
        },
        {
          permanent: locations.every((row) => row.special_use === "trash"),
          trashRemoteId: trash[0]?.remote_id ?? null,
        },
      );
    } finally {
      await connector.close();
    }
    // The trash copy (or nothing, for good) comes with the next sync.
    await this.sql`update mail_account set next_sync_at = 0 where id = ${job.accountId}`;
    await finish(this.sql, job, this.id, { state: "done", durationMs: Date.now() - started });
  }

  /** Archive a message as .eml: its source as the server holds it, stored as a vault file. */
  private async eml(job: ClaimedJob, policy: MailPolicy, started: number): Promise<void> {
    const payload = job.payload as {
      messageId?: string;
      ownerId?: string;
      portfolioId?: string | null;
      documentId?: string;
      actor?: string;
      shareId?: string | null;
    };
    const rows = await this.sql<{
      id: string;
      subject: string;
      internet_message_id: string;
      provider_message_id: string;
      remote_uid: unknown;
      remote_id: string | null;
    }>`
      select m.id, m.subject, m.internet_message_id, m.provider_message_id, l.remote_uid, f.remote_id
      from mail_message m
      left join mail_message_location l on l.message_id = m.id and l.deleted_at is null
      left join mail_folder f on f.id = l.folder_id
      where m.id = ${payload.messageId ?? ""} and m.account_id = ${job.accountId} and m.user_id = ${job.userId}
      limit 1
    `;
    const message = rows[0];
    if (!message || !payload.documentId) {
      await finish(this.sql, job, this.id, { state: "cancelled", durationMs: 0 });
      return;
    }
    // The destination is checked again: rights may have changed since the request.
    const target = await uploadTarget(this.sql, job.userId, {
      shareId: payload.shareId ?? null,
      portfolioId: payload.portfolioId ?? null,
    });
    if (typeof target === "string") throw new MailError("permanent", target);
    const account = await connectorAccount(this.sql, job.accountId);
    if (!account?.secret) throw new MailError("auth", "La cuenta está desconectada.");
    const connector = await buildConnector(this.sql, account);
    const chunks: Uint8Array[] = [];
    try {
      await connector.fetchRaw(
        {
          providerMessageId: message.provider_message_id,
          uid: message.remote_uid == null ? null : Number(message.remote_uid),
          folderRemoteId: message.remote_id,
        },
        { write: async (chunk) => void chunks.push(new Uint8Array(chunk)) },
        policy.maxAttachmentBytes,
      );
    } finally {
      await connector.close();
    }
    const bytes = Buffer.concat(chunks);
    const full = await checkSpace(this.sql, {
      ...target,
      uploaderId: job.userId,
      bytes: bytes.byteLength,
    });
    if (full) throw new MailError("permanent", full);
    const key = newFileKey(target.ownerId);
    await putBlob(this.sql, key, bytes, "message/rfc822");
    const blocked = await blockUnsafeBlob(this.sql, key);
    if (blocked) throw new MailError("permanent", blocked.message);
    const title = safeFileName(message.subject.trim() || "Correo sin asunto", "Correo").slice(
      0,
      150,
    );
    const now = Date.now();
    const actor = String(payload.actor ?? "");
    await registerImportedDoc(this.sql, target.ownerId, {
      id: payload.documentId,
      title,
      kind: "file",
      portfolioId: target.portfolioId,
      content: "",
      file: { name: `${title}.eml`, mime: "message/rfc822", key, size: bytes.byteLength },
      links: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    });
    await this.sql`
      insert into mail_archive_reference (id, user_id, account_id, message_id, attachment_id, document_owner_id,
        document_id, portfolio_id, format, internet_message_id, archived_by, archived_at)
      values (${randomUUID()}, ${job.userId}, ${job.accountId}, ${message.id}, null, ${target.ownerId},
        ${payload.documentId}, ${target.portfolioId}, 'eml', ${message.internet_message_id}, ${actor}, ${now})
    `;
    logEvent("mail.archive.eml", { worker: this.id, job: job.id, bytes: bytes.byteLength });
    await finish(this.sql, job, this.id, { state: "done", durationMs: Date.now() - started });
  }

  /** Delete an account's local copy: stored attachments first, then the rows. */
  private async cleanup(job: ClaimedJob, started: number): Promise<void> {
    for (;;) {
      const blobs = await this.sql<{ id: string; storage_key: string }>`
        select id, storage_key from mail_attachment where account_id = ${job.accountId} and storage_key is not null limit 200
      `;
      if (!blobs.length) break;
      for (const blob of blobs) {
        await deleteBlob(this.sql, blob.storage_key).catch(() => undefined);
        await this.sql`update mail_attachment set storage_key = null where id = ${blob.id}`;
      }
    }
    await this.sql`delete from mail_job where account_id = ${job.accountId} and id <> ${job.id}`;
    await finish(this.sql, job, this.id, { state: "done", durationMs: Date.now() - started });
    await this.sql`delete from mail_account where id = ${job.accountId} and status = 'deleting'`;
    logEvent("mail.account.deleted", { worker: this.id, account: job.accountId });
  }
}
