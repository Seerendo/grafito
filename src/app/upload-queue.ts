import { create } from "zustand";
import { UploadError } from "@/app/files";
import { t } from "@/app/i18n";
import { NO_RULES, type ExtensionRules } from "@/domain/file-extensions";
import {
  BatchProgress,
  failureState,
  planBatch,
  type BatchCounts,
  type BatchEntry,
} from "@/domain/vault/upload-batch";
import { uuid } from "@/lib/uuid";
import { extensionRules } from "@/server/file-rules.functions";

/**
 * Background uploads. A drop or a selection becomes a job that runs while the person keeps
 * working: nothing opens and the selection does not move. Folders are created first, outermost
 * to innermost, one at a time; then files go up a few at a time, each into a folder that already
 * exists on the server. A file counts as uploaded only when the server stored it and its
 * document (see UploadDestination.putFile): from then on it can be opened, shared or deleted.
 * A job can be paused (files in flight are abandoned and sent again on resume), resumed or
 * cancelled. Jobs live in this tab: a reload asks first, and dropping the same folder again
 * afterwards skips what already arrived (same name and size in the same folder).
 */

/** Where a job puts its folders and files: the personal vault or an editable share. */
export type UploadDestination = {
  label: string;
  rootId: string | null;
  /** Make sure the destination exists on the server; an error message when it does not. */
  prepare?: () => Promise<string | null>;
  /** Existing folder with that name under parentId, if any. */
  findFolder: (parentId: string | null, name: string) => string | null;
  createFolder: (parentId: string | null, name: string, importId: string) => Promise<string>;
  /** The same file (name and size) is already in that folder. */
  hasFile?: (folderId: string | null, name: string, size: number) => boolean;
  /** The document with this id is known here (stored by an earlier try of the same entry). */
  hasDoc?: (docId: string) => boolean;
  /**
   * Resolves once the server stored the file and the document that holds it, under docId when
   * the destination takes the browser's ids.
   */
  putFile: (
    file: File,
    folderId: string | null,
    signal: AbortSignal,
    importId: string,
    docId: string,
  ) => Promise<void>;
  /** Let the views catch up with the server: called when a job stops. */
  checkpoint: () => Promise<void>;
  /** False when the job can no longer run here (another person signed in). */
  stillValid?: () => boolean;
  /** Log what the job measured on the server, once it ends. */
  report?: (summary: JobReport) => Promise<void>;
};

export type JobStatus = "running" | "paused" | "cancelled" | "done";

/** What the panel shows for a job. */
export type JobView = {
  id: string;
  label: string;
  status: JobStatus;
  counts: BatchCounts;
  current: string;
  /** Entries that did not upload, with the reason. */
  problems: { path: string; state: BatchEntry["state"]; reason: string }[];
  error: string;
};

/** Measured for one job; see reportImport. */
export type JobReport = {
  importId: string;
  status: "done" | "cancelled";
  ms: number;
  folders: number;
  files: number;
  done: number;
  existing: number;
  failed: number;
  skipped: number;
  bytes: number;
  syncMs: number;
  syncs: number;
  errors: Record<string, number>;
};

type Job = {
  id: string;
  destination: UploadDestination;
  batch: BatchProgress;
  files: File[];
  ids: Map<string, string | null>;
  status: JobStatus;
  /** Files in flight, by entry index. */
  flight: Map<number, AbortController>;
  current: string;
  error: string;
  waiters: (() => void)[];
  started: number;
  errors: Record<string, number>;
};

const jobs = new Map<string, Job>();

export const useUploadQueue = create<{ jobs: JobView[] }>(() => ({ jobs: [] }));

/** Files sent at the same time. The antivirus scan dominates each one; more only queue there. */
export const FILE_CONCURRENCY = 3;

function view(job: Job): JobView {
  // Paused or cancelled shows once the files whose last request was already sent are settled:
  // from then on nothing moves.
  const settling = job.flight.size > 0 && (job.status === "paused" || job.status === "cancelled");
  return {
    id: job.id,
    label: job.destination.label,
    status: settling ? "running" : job.status,
    counts: structuredClone(job.batch.counts),
    current: job.current,
    problems: [...job.batch.problems],
    error: job.error,
  };
}

let publishing = false;

/** Show the jobs' state; several changes in the same task are shown once. */
function publish(): void {
  if (publishing) return;
  publishing = true;
  queueMicrotask(() => {
    publishing = false;
    useUploadQueue.setState({ jobs: [...jobs.values()].map(view) });
  });
}

/** Errors are kept in Spanish, like server messages, and translated where shown. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "No se pudo subir.";
}

function countError(job: Job, stage: string): void {
  job.errors[stage] = (job.errors[stage] ?? 0) + 1;
}

function nameOf(entry: BatchEntry): string {
  return entry.path.split("/").pop() ?? entry.path;
}

/** The server id of the folder an entry goes into; undefined when it is not there. */
function parentOf(job: Job, entry: BatchEntry): string | null | undefined {
  if (entry.folder === "") return job.destination.rootId;
  return job.ids.get(entry.folder);
}

async function folderStep(job: Job, index: number): Promise<void> {
  const entry = job.batch.entries[index]!;
  const blocked = job.batch.blocked(entry);
  if (blocked) {
    job.batch.set(index, "failed", blocked);
    return;
  }
  const parentId = parentOf(job, entry);
  if (parentId === undefined) {
    // Never placed at the top instead: its folder is not on the server.
    job.batch.set(index, "failed", "No se pudo crear la carpeta que la contiene.");
    countError(job, "folder");
    return;
  }
  job.current = entry.path;
  publish();
  try {
    const name = nameOf(entry);
    const found = job.destination.findFolder(parentId, name);
    job.ids.set(entry.path, found ?? (await job.destination.createFolder(parentId, name, job.id)));
    job.batch.set(index, "done");
  } catch (error) {
    job.batch.set(index, "failed", messageOf(error));
    countError(job, "folder");
  }
}

async function fileStep(job: Job, index: number): Promise<void> {
  const entry = job.batch.entries[index]!;
  const blocked = job.batch.blocked(entry);
  if (blocked) {
    job.batch.set(index, "failed", blocked);
    return;
  }
  const folderId = parentOf(job, entry);
  if (folderId === undefined) {
    job.batch.set(index, "failed", "No se pudo crear la carpeta que lo contiene.");
    countError(job, "folder");
    return;
  }
  const file = job.files[entry.source];
  if (!file) {
    job.batch.set(index, "failed", "No se pudo leer el archivo.");
    countError(job, "read");
    return;
  }
  // Stored by an earlier try whose answer did not arrive (a pause): it is this job's upload.
  if (entry.docId && job.destination.hasDoc?.(entry.docId)) {
    job.batch.set(index, "done");
    return;
  }
  if (job.destination.hasFile?.(folderId, file.name, file.size)) {
    job.batch.set(index, "existing");
    return;
  }
  entry.docId ??= uuid();
  const controller = new AbortController();
  job.flight.set(index, controller);
  job.current = entry.path;
  publish();
  try {
    await job.destination.putFile(file, folderId, controller.signal, job.id, entry.docId);
    job.batch.set(index, "done");
  } catch (error) {
    // Paused or cancelled during the transfer: the file stays pending and is sent again on
    // resume. An answer from the server (a refusal) is reported even then.
    if (controller.signal.aborted && !(error instanceof UploadError)) return;
    const status = error instanceof UploadError ? error.status : null;
    job.batch.set(index, failureState(status), messageOf(error));
    // The server logs the stage that failed (storage, scan, register) under the same id.
    countError(job, status === 422 ? "antivirus" : status === null ? "network" : "transfer");
  } finally {
    job.flight.delete(index);
  }
}

async function runJob(job: Job): Promise<void> {
  if (job.destination.prepare) {
    const problem = await job.destination.prepare().catch((error: unknown) => messageOf(error));
    if (problem) {
      job.status = "cancelled";
      job.error = problem;
    }
  }
  job.batch.rewind();
  const valid = () => {
    if (!job.destination.stillValid || job.destination.stillValid()) return true;
    job.status = "cancelled";
    job.error = "La sesión cambió; la carga se detuvo.";
    return false;
  };
  // Folders, in order: each one's parent is created before it.
  while (job.status === "running" && valid()) {
    const index = job.batch.nextFolder();
    if (index === -1) break;
    await folderStep(job, index);
    publish();
  }
  // Files, a few at a time; every folder they need was settled above.
  const lane = async () => {
    while (job.status === "running" && valid()) {
      const index = job.batch.claimFile(new Set(job.flight.keys()));
      if (index === -1) return;
      // Claimed before the first await, so no other lane takes it.
      job.flight.set(index, new AbortController());
      try {
        await fileStep(job, index);
      } finally {
        job.flight.delete(index);
      }
      publish();
    }
  };
  await Promise.all(Array.from({ length: FILE_CONCURRENCY }, lane));
  if (job.status === "running") job.status = "done";
  job.current = "";
  // Shown once the views caught up and the counts are final (see reconcile).
  await job.destination.checkpoint().catch((error: unknown) => {
    console.warn("[upload] the views could not catch up after the job", messageOf(error));
  });
  reconcile(job);
  publish();
  if (job.status === "done" || job.status === "cancelled") finish(job);
}

/**
 * After a pause or a cancel, files whose answer was abandoned may still have been stored by the
 * server. Once the views caught up (checkpoint), those count as uploaded, not as left to send.
 */
function reconcile(job: Job): void {
  const known = job.destination.hasDoc;
  if (!known) return;
  job.batch.entries.forEach((entry, index) => {
    if (entry.kind === "file" && entry.state === "pending" && entry.docId && known(entry.docId))
      job.batch.set(index, "done");
  });
}

/** Wake whoever waits for the job, and log what it measured. */
function finish(job: Job): void {
  for (const wake of job.waiters.splice(0)) wake();
  const counts = job.batch.counts;
  const report: JobReport = {
    importId: job.id,
    status: job.status === "done" ? "done" : "cancelled",
    ms: Math.round(performance.now() - job.started),
    folders: counts.folders.total,
    files: counts.files.total,
    done: counts.files.done,
    existing: counts.files.existing,
    failed: counts.files.failed + counts.files.infected + counts.folders.failed,
    skipped: counts.files.skipped,
    bytes: counts.bytes.done,
    ...syncCost(),
    errors: job.errors,
  };
  console.info("[upload] job finished", report);
  void job.destination.report?.(report).catch((error: unknown) => {
    console.warn("[upload] the job summary could not be sent", messageOf(error));
  });
}

let syncCost: () => { syncMs: number; syncs: number } = () => ({ syncMs: 0, syncs: 0 });

/** Where the report reads the synchronization cost from (app/vault/sync.ts syncTotals). */
export function measureSyncWith(read: () => { syncMs: number; syncs: number }): void {
  syncCost = read;
}

let pumping = false;

/** Run running jobs one after another. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = [...jobs.values()].find((item) => item.status === "running");
      if (!job) break;
      await runJob(job);
    }
  } finally {
    pumping = false;
  }
}

/**
 * Queue files (with their paths inside the drop) and empty folders for a destination. Resolves
 * once the job finished or was cancelled, with its id.
 */
export async function enqueueUpload(
  input: { files: { file: File; relativePath: string }[]; folders?: string[] },
  destination: UploadDestination,
): Promise<string> {
  const rules: ExtensionRules = await extensionRules().catch(() => NO_RULES);
  const entries = planBatch(
    input.files.map((item) => ({ relativePath: item.relativePath, size: item.file.size })),
    input.folders ?? [],
    rules,
  );
  if (entries.length === 0) return "";
  const job: Job = {
    id: uuid(),
    destination,
    batch: new BatchProgress(entries),
    files: input.files.map((item) => item.file),
    ids: new Map([["", destination.rootId]]),
    status: "running",
    flight: new Map(),
    current: "",
    error: "",
    waiters: [],
    started: performance.now(),
    errors: {},
  };
  jobs.set(job.id, job);
  publish();
  const finished = new Promise<void>((resolve) => job.waiters.push(resolve));
  void pump();
  await finished;
  return job.id;
}

function abortFlight(job: Job): void {
  for (const controller of job.flight.values()) controller.abort();
}

export function pauseUpload(id: string): void {
  const job = jobs.get(id);
  if (job?.status !== "running") return;
  job.status = "paused";
  abortFlight(job);
  publish();
}

export function resumeUpload(id: string): void {
  const job = jobs.get(id);
  if (job?.status !== "paused") return;
  job.status = "running";
  publish();
  void pump();
}

export function cancelUpload(id: string): void {
  const job = jobs.get(id);
  if (!job || job.status === "done" || job.status === "cancelled") return;
  const wasPaused = job.status === "paused";
  job.status = "cancelled";
  abortFlight(job);
  publish();
  // A paused job has no loop to finish it.
  if (wasPaused) {
    void job.destination
      .checkpoint()
      .catch((error: unknown) => {
        console.warn("[upload] the views could not catch up after cancelling", messageOf(error));
      })
      .then(() => {
        reconcile(job);
        publish();
        finish(job);
      });
  }
}

/** Remove a finished or cancelled job from the panel. */
export function dismissUpload(id: string): void {
  const job = jobs.get(id);
  if (!job || job.status === "running" || job.status === "paused") return;
  jobs.delete(id);
  publish();
}

/** Uploads still to send: a reload or closing the tab would lose them. */
export function uploadsPending(): boolean {
  return [...jobs.values()].some(
    (job) => (job.status === "running" || job.status === "paused") && !job.batch.finished(),
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!uploadsPending()) return;
    event.preventDefault();
    event.returnValue = t("Hay una carga en curso.");
  });
}
