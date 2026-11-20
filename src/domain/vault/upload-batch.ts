import { blockedMessage, uploadBlocked, type ExtensionRules } from "../file-extensions.ts";
import { folderPlan, ignoredUpload } from "./folders.ts";

/**
 * A background upload batch: every folder and file of one drop or selection, in the order they
 * are created. Folders come first, outermost to innermost, so each file finds its folder.
 */

/** existing: the same file (name and size) was already in that folder; it is not sent again. */
export type EntryState = "pending" | "done" | "existing" | "skipped" | "infected" | "failed";

export type BatchEntry = {
  /** Path inside the drop, "/"-separated; for a folder, the folder itself. */
  path: string;
  kind: "folder" | "file";
  /** Folder path that holds the entry; "" is the destination. */
  folder: string;
  /** Index into the files the batch was planned from; -1 for folders. */
  source: number;
  size: number;
  state: EntryState;
  reason: string;
  /**
   * Id of the document a file is stored under, chosen on the first try and kept for the next
   * ones: the server never stores it twice, and a file it stored while the answer was lost (a
   * pause, a cancel) is recognized afterwards.
   */
  docId?: string;
};

export type BatchCounts = {
  folders: { total: number; done: number; failed: number };
  files: {
    total: number;
    done: number;
    existing: number;
    skipped: number;
    infected: number;
    failed: number;
    pending: number;
  };
  bytes: { total: number; done: number };
};

/**
 * Plan a batch from relative file paths (with sizes) and empty folder paths. System files are
 * dropped; blocked extensions are kept as skipped so the summary names them.
 */
export function planBatch(
  files: readonly { relativePath: string; size: number }[],
  emptyFolders: readonly string[],
  rules: ExtensionRules,
): BatchEntry[] {
  const byPath = new Map<string, number>();
  files.forEach((file, index) => {
    if (ignoredUpload(file.relativePath)) return;
    const planned = folderPlan([file.relativePath]).files[0];
    if (planned && !byPath.has(planned.relativePath)) byPath.set(planned.relativePath, index);
  });
  const plan = folderPlan([...byPath.keys()], emptyFolders);
  const entries: BatchEntry[] = plan.folders.map((path) => {
    const slash = path.lastIndexOf("/");
    return {
      path,
      kind: "folder",
      folder: slash === -1 ? "" : path.slice(0, slash),
      source: -1,
      size: 0,
      state: "pending",
      reason: "",
    };
  });
  for (const planned of plan.files) {
    const source = byPath.get(planned.relativePath) ?? -1;
    const name = planned.relativePath.split("/").pop() ?? planned.relativePath;
    const blocked = uploadBlocked(name, rules);
    entries.push({
      path: planned.relativePath,
      kind: "file",
      folder: planned.folder,
      source,
      size: files[source]?.size ?? 0,
      state: blocked ? "skipped" : "pending",
      reason: blocked ? blockedMessage(name) : "",
    });
  }
  return entries;
}

/** How a refused file is reported: an antivirus hit (422) apart from other failures. */
export function failureState(status: number | null): "infected" | "skipped" | "failed" {
  if (status === 422) return "infected";
  if (status === 415) return "skipped";
  return "failed";
}

export function countBatch(entries: readonly BatchEntry[]): BatchCounts {
  const counts: BatchCounts = {
    folders: { total: 0, done: 0, failed: 0 },
    files: { total: 0, done: 0, existing: 0, skipped: 0, infected: 0, failed: 0, pending: 0 },
    bytes: { total: 0, done: 0 },
  };
  for (const entry of entries) {
    if (entry.kind === "folder") {
      counts.folders.total += 1;
      if (entry.state === "done") counts.folders.done += 1;
      else if (entry.state === "failed") counts.folders.failed += 1;
      continue;
    }
    counts.files.total += 1;
    counts.files[entry.state] += 1;
    counts.bytes.total += entry.size;
    if (entry.state === "done") counts.bytes.done += entry.size;
  }
  return counts;
}

/** The next entry to work on, or -1 when nothing is left. */
export function nextPending(entries: readonly BatchEntry[]): number {
  return entries.findIndex((entry) => entry.state === "pending");
}

/** A file or folder whose folder failed cannot be placed: it fails with that reason. */
export function blockedByFolder(entries: readonly BatchEntry[], index: number): string | null {
  const entry = entries[index];
  if (!entry || entry.folder === "") return null;
  const parent = entries.find((item) => item.kind === "folder" && item.path === entry.folder);
  return parent?.state === "failed" ? parent.reason || "No se pudo crear la carpeta." : null;
}

/**
 * A batch being worked on, with what each step needs at hand: folders by path, cursors to the
 * next folder and file, and counts and problems kept up to date as entries change. Each step
 * costs the same however large the batch is.
 */
export class BatchProgress {
  readonly entries: BatchEntry[];
  readonly counts: BatchCounts;
  readonly problems: { path: string; state: EntryState; reason: string }[] = [];
  private readonly folderAt = new Map<string, number>();
  private folderCursor = 0;
  private fileCursor = 0;

  constructor(entries: BatchEntry[]) {
    this.entries = entries;
    this.counts = countBatch(entries);
    entries.forEach((entry, index) => {
      if (entry.kind === "folder") this.folderAt.set(entry.path, index);
      else if (entry.state !== "done" && entry.state !== "pending")
        this.problems.push({ path: entry.path, state: entry.state, reason: entry.reason });
    });
  }

  /** The folder entry for a path, or undefined for the destination itself. */
  folder(path: string): BatchEntry | undefined {
    const index = this.folderAt.get(path);
    return index === undefined ? undefined : this.entries[index];
  }

  /** Why the entry cannot be placed: its folder failed. */
  blocked(entry: BatchEntry): string | null {
    if (entry.folder === "") return null;
    const parent = this.folder(entry.folder);
    return parent?.state === "failed" ? parent.reason || "No se pudo crear la carpeta." : null;
  }

  /** The next pending folder, in plan order (outermost first), or -1. */
  nextFolder(): number {
    while (this.folderCursor < this.entries.length) {
      const entry = this.entries[this.folderCursor]!;
      if (entry.kind === "folder" && entry.state === "pending") return this.folderCursor;
      this.folderCursor += 1;
    }
    return -1;
  }

  /** Claim the next pending file that is not in flight, or -1. */
  claimFile(inFlight: ReadonlySet<number>): number {
    for (let index = this.fileCursor; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (entry.kind !== "file" || entry.state !== "pending") {
        if (index === this.fileCursor) this.fileCursor += 1;
        continue;
      }
      if (!inFlight.has(index)) return index;
    }
    return -1;
  }

  /** Rewind the cursors, after a pause left entries pending. */
  rewind(): void {
    this.folderCursor = 0;
    this.fileCursor = 0;
  }

  set(index: number, state: EntryState, reason = ""): void {
    const entry = this.entries[index];
    if (!entry || entry.state === state) return;
    const previous = entry.state;
    entry.state = state;
    entry.reason = reason;
    if (entry.kind === "folder") {
      if (previous === "done") this.counts.folders.done -= 1;
      if (previous === "failed") this.counts.folders.failed -= 1;
      if (state === "done") this.counts.folders.done += 1;
      if (state === "failed") {
        this.counts.folders.failed += 1;
        this.problems.push({ path: entry.path, state, reason });
      }
      return;
    }
    this.counts.files[previous] -= 1;
    this.counts.files[state] += 1;
    if (state === "done") this.counts.bytes.done += entry.size;
    if (previous === "done") this.counts.bytes.done -= entry.size;
    if (state !== "done" && state !== "pending" && state !== "existing")
      this.problems.push({ path: entry.path, state, reason });
  }

  /** Nothing left to try. */
  finished(): boolean {
    return this.counts.files.pending === 0 && this.nextFolder() === -1;
  }
}
