import { useSyncExternalStore } from "react";

let flags: Record<string, boolean> | null = null;
let loadedAt = 0;
const listeners = new Set<() => void>();

export function setPluginFlags(next: Record<string, boolean> | null) {
  flags = next;
  loadedAt = Date.now();
  for (const listener of listeners) listener();
}

export function pluginFlagsFresh(): boolean {
  return flags !== null && Date.now() - loadedAt < 60_000;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginEnabled(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (flags ? flags[id] !== false : true),
    () => true,
  );
}
