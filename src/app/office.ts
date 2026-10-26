import { useEffect, useState } from "react";
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
