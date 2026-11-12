/**
 * Vault writes call nudgeGraph so the graph follows within a second. It only records the owner:
 * the sync loop (sync.ts) registers itself here, which keeps vault.ts free of Grafeno imports.
 */

let listener: ((ownerId: string) => void) | null = null;

export function onGraphNudge(next: (ownerId: string) => void): void {
  listener = next;
}

export function nudgeGraph(ownerId: string): void {
  listener?.(ownerId);
}
