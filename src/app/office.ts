import { useEffect, useState } from "react";
import { create } from "zustand";
import { officeStatus } from "@/server/office.functions";

/** Client Office editor availability and supported files; see server/office.ts. */

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)$/i;

export function isOfficeFile(name: string): boolean {
  return OFFICE.test(name);
}

let known: Promise<boolean> | null = null;

function officeAvailable(): Promise<boolean> {
  known ??= officeStatus()
    .then((status) => status.enabled)
    .catch(() => {
      known = null;
      return false;
    });
  return known;
}

export function useOfficeEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void officeAvailable().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

/** Incrementing this counter reopens an editor with restored content after a file-version restore. */
export const useOfficeReload = create<{
  generation: Record<string, number>;
  reload: (docId: string) => void;
}>((set) => ({
  generation: {},
  reload: (docId) =>
    set((state) => ({
      generation: { ...state.generation, [docId]: (state.generation[docId] ?? 0) + 1 },
    })),
}));

/** Action performed by an open document editor before restoring a version. */
const beforeRestore = new Map<string, () => Promise<void>>();

export function onBeforeRestore(docId: string, run: () => Promise<void>): () => void {
  beforeRestore.set(docId, run);
  return () => {
    if (beforeRestore.get(docId) === run) beforeRestore.delete(docId);
  };
}

/**
 * Before restoration, flush pending changes and close the editor through Host_VersionRestore so
 * stale content cannot overwrite the restored version.
 */
export async function prepareRestore(docId: string): Promise<void> {
  await beforeRestore.get(docId)?.();
}
