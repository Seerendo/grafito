import { create } from "zustand";
import { UploadError } from "@/app/files";
import { t } from "@/app/i18n";
import { NO_RULES, type ExtensionRules } from "@/domain/file-extensions";
import {
  blockedByFolder,
  countBatch,
  failureState,
  nextPending,
  planBatch,
  type BatchCounts,
  type BatchEntry,
} from "@/domain/vault/upload-batch";
import { uuid } from "@/lib/uuid";
import { extensionRules } from "@/server/file-rules.functions";

/**
 * Background uploads. A drop or a selection becomes a job; jobs run one file at a time, in
 * order, while the person keeps working: nothing opens and the selection does not move. A job
 * can be paused (the file in flight is abandoned and sent again on resume), resumed from the
 * first entry not yet uploaded, or cancelled. Jobs live in this tab: a reload asks first.
 */

/** Where a job puts its folders and files: the personal vault or an editable share. */
export type UploadDestination = {
  label: string;
  rootId: string | null;
  /** Existing folder with that name under parentId, if any. */
  findFolder: (parentId: string | null, name: string) => string | null;
  createFolder: (parentId: string | null, name: string) => Promise<string>;
  putFile: (file: File, folderId: string | null, signal: AbortSignal) => Promise<void>;
  /** Let the server and the views catch up: called every few files and when a job stops. */
  checkpoint: () => Promise<void>;
  /** False when the job can no longer run here (another person signed in). */
  stillValid?: () => boolean;
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

type Job = {
  id: string;
  destination: UploadDestination;
  entries: BatchEntry[];
  files: File[];
  ids: Map<string, string | null>;
  status: JobStatus;
  abort: AbortController | null;
  current: string;
  error: string;
  waiters: (() => void)[];
};

const jobs = new Map<string, Job>();

export const useUploadQueue = create<{ jobs: JobView[] }>(() => ({ jobs: [] }));

/** Files uploaded between two checkpoints. */
const CHECKPOINT_EVERY = 25;

function view(job: Job): JobView {
  return {
    id: job.id,
    label: job.destination.label,
    status: job.status,
    counts: countBatch(job.entries),
    current: job.current,
    problems: job.entries
      .filter((entry) => entry.state !== "done" && entry.state !== "pending")
      .map((entry) => ({ path: entry.path, state: entry.state, reason: entry.reason })),
    error: job.error,
  };
}

function publish(): void {
  useUploadQueue.setState({ jobs: [...jobs.values()].map(view) });
}

/** Errors are kept in Spanish, like server messages, and translated where shown. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "No se pudo subir.";
}

async function step(job: Job, index: number): Promise<void> {
  const entry = job.entries[index]!;
  const blocked = blockedByFolder(job.entries, index);
  if (blocked) {
    entry.state = "failed";
    entry.reason = blocked;
    return;
  }
  const parentId =
    entry.folder === "" ? job.destination.rootId : (job.ids.get(entry.folder) ?? null);
  const name = entry.path.split("/").pop() ?? entry.path;
  job.current = entry.path;
  publish();
  if (entry.kind === "folder") {
    try {
      const found = job.destination.findFolder(parentId, name);
      job.ids.set(entry.path, found ?? (await job.destination.createFolder(parentId, name)));
      entry.state = "done";
    } catch (error) {
      entry.state = "failed";
      entry.reason = messageOf(error);
    }
    return;
  }
  const file = job.files[entry.source];
  if (!file) {
    entry.state = "failed";
    entry.reason = "No se pudo leer el archivo.";
    return;
  }
  const controller = new AbortController();
  job.abort = controller;
  try {
    await job.destination.putFile(file, parentId, controller.signal);
    entry.state = "done";
  } catch (error) {
    // Paused or cancelled: the file stays pending and is sent again on resume.
    if (controller.signal.aborted) return;
    entry.state = failureState(error instanceof UploadError ? error.status : null);
    entry.reason = messageOf(error);
  } finally {
    job.abort = null;
  }
}

async function runJob(job: Job): Promise<void> {
  let sinceCheckpoint = 0;
  while (job.status === "running") {
    if (job.destination.stillValid && !job.destination.stillValid()) {
      job.status = "cancelled";
      job.error = "La sesión cambió; la carga se detuvo.";
      break;
    }
    const index = nextPending(job.entries);
    if (index === -1) {
      job.status = "done";
      break;
    }
    const before = job.entries[index]!.kind;
    await step(job, index);
    if (before === "file") sinceCheckpoint += 1;
    publish();
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      sinceCheckpoint = 0;
      await job.destination.checkpoint().catch(() => undefined);
    }
  }
  job.current = "";
  await job.destination.checkpoint().catch(() => undefined);
  publish();
  if (job.status === "done" || job.status === "cancelled") {
    for (const wake of job.waiters.splice(0)) wake();
  }
}

let pumping = false;

/** Run running jobs one after another; a single file is in flight at a time. */
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
    entries,
    files: input.files.map((item) => item.file),
    ids: new Map([["", destination.rootId]]),
    status: "running",
    abort: null,
    current: "",
    error: "",
    waiters: [],
  };
  jobs.set(job.id, job);
  publish();
  const finished = new Promise<void>((resolve) => job.waiters.push(resolve));
  void pump();
  await finished;
  return job.id;
}

export function pauseUpload(id: string): void {
  const job = jobs.get(id);
  if (job?.status !== "running") return;
  job.status = "paused";
  job.abort?.abort();
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
  job.abort?.abort();
  publish();
  // A paused job has no loop to finish it: wake its waiters here.
  if (wasPaused) {
    void job.destination.checkpoint().catch(() => undefined);
    for (const wake of job.waiters.splice(0)) wake();
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
    (job) =>
      (job.status === "running" || job.status === "paused") && nextPending(job.entries) !== -1,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!uploadsPending()) return;
    event.preventDefault();
    event.returnValue = t("Hay una carga en curso.");
  });
}
