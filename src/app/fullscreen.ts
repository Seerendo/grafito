import { create } from "zustand";

/**
 * Fullscreen editing hides VaultApp panels and requests browser fullscreen for the whole app so
 * dialogs remain visible. Unsupported browsers retain the panel-free view. Esc or the toggle
 * exits. Where keyboard.lock is supported, reserve Esc so it closes dialogs before leaving
 * fullscreen; holding Esc still exits.
 */

type KeyboardLock = { lock?: (keys: string[]) => Promise<void>; unlock?: () => void };

function keyboard(): KeyboardLock | undefined {
  return (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
}

export const useFullscreen = create<{ on: boolean; toggle: () => void; exit: () => void }>(
  (set, get) => ({
    on: false,
    toggle: () => (get().on ? get().exit() : enter(set)),
    exit: () => {
      set({ on: false });
      keyboard()?.unlock?.();
      if (typeof document !== "undefined" && document.fullscreenElement)
        void document.exitFullscreen().catch(() => undefined);
    },
  }),
);

function enter(set: (state: { on: boolean }) => void): void {
  set({ on: true });
  const root = document.documentElement;
  if (!root.requestFullscreen || document.fullscreenElement) return;
  void root
    .requestFullscreen()
    .then(() => keyboard()?.lock?.(["Escape"]))
    .catch(() => undefined);
}

/** Leaving browser fullscreen also leaves the panel-free view. */
export function watchFullscreen(): () => void {
  const onChange = () => {
    if (!document.fullscreenElement && useFullscreen.getState().on) {
      keyboard()?.unlock?.();
      useFullscreen.setState({ on: false });
    }
  };
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}
