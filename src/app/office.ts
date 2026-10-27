import { useEffect, useState } from "react";
import { create } from "zustand";
import { officeStatus } from "@/server/office.functions";

/**
 * Editor de Office en el cliente: si el servidor lo tiene activado (perfil
 * `office`) y qué archivos abre. Ver `server/office.ts`.
 */

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

/**
 * Al restaurar una versión de un archivo, el editor abierto aún tiene el
 * contenido anterior: subir el contador lo vuelve a abrir con el restaurado.
 */
export const useOfficeReload = create<{ generation: Record<string, number>; reload: (docId: string) => void }>((set) => ({
  generation: {},
  reload: (docId) => set((state) => ({ generation: { ...state.generation, [docId]: (state.generation[docId] ?? 0) + 1 } })),
}));

/** Lo que hace el editor abierto de un documento antes de restaurar una versión. */
const beforeRestore = new Map<string, () => Promise<void>>();

export function onBeforeRestore(docId: string, run: () => Promise<void>): () => void {
  beforeRestore.set(docId, run);
  return () => {
    if (beforeRestore.get(docId) === run) beforeRestore.delete(docId);
  };
}

/**
 * Antes de restaurar una versión de un archivo abierto en el editor, este
 * guarda lo pendiente y cierra el documento (`Host_VersionRestore`); así no
 * sigue con el contenido anterior ni lo vuelve a guardar encima.
 */
export async function prepareRestore(docId: string): Promise<void> {
  await beforeRestore.get(docId)?.();
}
