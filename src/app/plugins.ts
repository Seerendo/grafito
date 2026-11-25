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

/** Whether an extension is known to be on and its service answering (false while unknown). */
export function usePluginActive(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => flags?.[id] === true,
    () => false,
  );
}

let asking: Promise<void> | null = null;

/** Load the flags when this page has none or they are older than a minute. */
export function refreshPluginFlags(): Promise<void> {
  if (pluginFlagsFresh()) return Promise.resolve();
  asking ??= import("@/server/admin.functions")
    .then(({ listPlugins }) => listPlugins())
    .then((next) => {
      if (Object.keys(next).length > 0) setPluginFlags(next);
    })
    .catch(() => undefined)
    .finally(() => {
      asking = null;
    });
  return asking;
}
