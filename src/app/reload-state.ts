import { useEffect, useRef } from "react";

/**
 * Restore screen position only after reload or language remount. Save on pagehide or
 * keepForRemount and read once. Normal navigation does not save state, so reopening starts
 * fresh.
 */

const REMOUNT = "grafito:before-remount";

/** Read saved state without deleting it; useSaveOnReload clears it on mount. */
export function readReloadState<T>(key: string): T | null {
  try {
    const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Save value under key only on reload or app remount. */
export function useSaveOnReload(key: string, value: unknown): void {
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    // State has been consumed on mount; later navigation starts fresh.
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* Storage unavailable. */
    }
    const save = () => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(latest.current));
      } catch {
        /* Optional convenience; failure is harmless. */
      }
    };
    window.addEventListener("pagehide", save);
    window.addEventListener(REMOUNT, save);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener(REMOUNT, save);
    };
  }, [key]);
}

/** Notify screens before a language remount so they save their positions. */
export function keepForRemount(): void {
  window.dispatchEvent(new Event(REMOUNT));
}
