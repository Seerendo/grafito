import { useEffect, useState } from "react";
import { notePresence } from "@/server/history.functions";

/** Editor heartbeat interval; server presence expires after thirty seconds. */
const BEAT_MS = 10_000;

/**
 * Other editors of docId, optionally under shareId, and this client's editing heartbeat.
 * Refresh while the document is open and the tab visible; withdraw presence when closing or
 * stopping editing.
 */
export function useNotePresence(
  docId: string | null,
  editing: boolean,
  shareId?: string,
): string[] {
  const [editors, setEditors] = useState<string[]>([]);

  useEffect(() => {
    setEditors([]);
    if (!docId) return;
    let cancelled = false;
    const beat = (state: boolean) =>
      notePresence({ data: { docId, editing: state, ...(shareId ? { shareId } : {}) } })
        .then((result) => {
          if (!cancelled) setEditors(result.editors);
        })
        .catch(() => undefined);
    void beat(editing);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void beat(editing);
    }, BEAT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (editing)
        void notePresence({
          data: { docId, editing: false, ...(shareId ? { shareId } : {}) },
        }).catch(() => undefined);
    };
  }, [docId, editing, shareId]);

  return editors;
}
