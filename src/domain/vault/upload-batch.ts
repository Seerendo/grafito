import { blockedMessage, uploadBlocked, type ExtensionRules } from "../file-extensions.ts";
import { folderPlan, ignoredUpload } from "./folders.ts";

/**
 * A background upload batch: every folder and file of one drop or selection, in the order they
 * are created. Folders come first, outermost to innermost, so each file finds its folder.
 */

export type EntryState = "pending" | "done" | "skipped" | "infected" | "failed";

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
};

export type BatchCounts = {
  folders: { total: number; done: number; failed: number };
  files: {
    total: number;
    done: number;
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
    files: { total: 0, done: 0, skipped: 0, infected: 0, failed: 0, pending: 0 },
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
