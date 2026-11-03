import { useSyncExternalStore } from "react";
import { coveredBy, type ShareKind, type Visibility } from "@/domain/share";
import type { Document, Portfolio } from "@/domain/vault/types";
import { myShares } from "@/server/share.functions";

/** Current user's own shares, loaded and maintained by ShareMirror for directory, editor and dialogs. */
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
    /* No session or connection; retry on the next load. */
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

export function shareOf(
  list: readonly MyShare[],
  kind: ShareKind,
  targetId: string,
): MyShare | null {
  return list.find((share) => share.kind === kind && share.targetId === targetId) ?? null;
}

/**
 * Effective document and portfolio visibility, explicit or inherited from a shared portfolio.
 * Missing entries are private.
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

/** Absolute public URL for a link-shared item. */
export function publicUrl(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/p/${token}`;
}
