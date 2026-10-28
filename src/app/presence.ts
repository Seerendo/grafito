import { useEffect, useState } from "react";
import { notePresence } from "@/server/history.functions";

/** Cada cuánto avisa un editor abierto (el servidor olvida a los 30 s). */
const BEAT_MS = 10_000;

/**
 * Quién más está editando la nota `docId` (de `shareId`, si es compartida), y
 * aviso al servidor de si aquí se está editando. Se repite mientras la nota
 * está abierta y la pestaña visible; al cerrarla o dejar de editar, se retira.
 */
export function useNotePresence(docId: string | null, editing: boolean, shareId?: string): string[] {
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
      if (editing) void notePresence({ data: { docId, editing: false, ...(shareId ? { shareId } : {}) } }).catch(() => undefined);
    };
  }, [docId, editing, shareId]);

  return editors;
}
