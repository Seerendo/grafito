/**
 * One browser-wide session across tabs. localStorage records grafito.session-user; storage
 * events propagate sign-in, sign-out and user changes. Tabs return to sign-in or reload for the
 * new identity, avoiding stale or mixed-user sessions.
 */

const KEY = "grafito.session-user";

export function readSessionUser(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Record the current session owner; empty means signed out. */
export function writeSessionUser(userId: string): void {
  try {
    if (window.localStorage.getItem(KEY) !== userId) window.localStorage.setItem(KEY, userId);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Notify listeners of another tab's session change. */
export function onSessionUserChange(listener: (userId: string) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener(event.newValue ?? "");
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
