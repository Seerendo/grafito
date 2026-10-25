import { useSyncExternalStore } from "react";
import { coveredBy, type ShareKind, type Visibility } from "@/domain/share";
import type { Document, Portfolio } from "@/domain/vault/types";
import { myShares } from "@/server/share.functions";

/**
 * Lo que el usuario actual tiene compartido (solo sus elementos). Lo carga y
 * mantiene `ShareMirror`; lo leen el directorio, el editor y el diálogo.
 */
export type MyShare = Awaited<ReturnType<typeof myShares>>[number];

let shares: MyShare[] = [];
let snapshot = "[]";
const listeners = new Set<() => void>();

export function setMyShares(next: MyShare[]): void {
  const serialized = JSON.stringify(next);
  if (serialized === snapshot) return;
  snapshot = serialized;
  shares = next;
  listeners.forEach((listener) => listener());
}

export function clearMyShares(): void {
  setMyShares([]);
}

export async function loadMyShares(): Promise<void> {
  try {
    setMyShares(await myShares());
  } catch {
    /* sin sesión o sin conexión: se reintenta en la próxima carga */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMyShares(): MyShare[] {
  return useSyncExternalStore(
    subscribe,
    () => shares,
    () => shares,
  );
}

export function shareOf(list: readonly MyShare[], kind: ShareKind, targetId: string): MyShare | null {
  return list.find((share) => share.kind === kind && share.targetId === targetId) ?? null;
}

/**
 * Visibilidad efectiva de cada documento y portafolio: la propia o la heredada
 * de un portafolio compartido. Lo que no aparece es privado.
 */
export function visibilityMap(
  list: readonly MyShare[],
  portfolios: readonly Portfolio[],
  documents: readonly Document[],
): Map<string, Exclude<Visibility, "private">> {
  const result = new Map<string, Exclude<Visibility, "private">>();
  const mark = (id: string, visibility: Exclude<Visibility, "private">) => {
    if (result.get(id) !== "public") result.set(id, visibility);
  };
  for (const share of list) {
    const covered = coveredBy(share, portfolios, documents);
    covered.documentIds.forEach((id) => mark(id, share.visibility));
    covered.portfolioIds.forEach((id) => mark(id, share.visibility));
  }
  return result;
}

/** URL pública absoluta de un elemento compartido por enlace. */
export function publicUrl(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/p/${token}`;
}
