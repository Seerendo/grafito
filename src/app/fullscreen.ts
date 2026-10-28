import { create } from "zustand";

/**
 * Pantalla completa para trabajar una nota o un archivo: la app oculta la
 * barra superior y los paneles laterales (`VaultApp`) y pide al navegador la
 * pantalla completa de verdad. Va toda la app, no solo el editor, para que los
 * diálogos (vincular, compartir…) se sigan viendo. Si el navegador no la da
 * (iPhone), queda igualmente la vista sin paneles. Esc o el mismo botón salen.
 *
 * Esc: en pantalla completa el navegador lo usa para salir antes de que lo
 * vea la página, así que con un diálogo abierto se saldría de la pantalla
 * completa en vez de cerrarlo. Donde se puede (Chrome, Edge) la tecla se
 * reserva para la página (`navigator.keyboard.lock`): Esc cierra primero el
 * diálogo y luego sale (`VaultApp`); mantenerlo pulsado sigue saliendo.
 */

type KeyboardLock = { lock?: (keys: string[]) => Promise<void>; unlock?: () => void };

function keyboard(): KeyboardLock | undefined {
  return (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
}

export const useFullscreen = create<{ on: boolean; toggle: () => void; exit: () => void }>((set, get) => ({
  on: false,
  toggle: () => (get().on ? get().exit() : enter(set)),
  exit: () => {
    set({ on: false });
    keyboard()?.unlock?.();
    if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  },
}));

function enter(set: (state: { on: boolean }) => void): void {
  set({ on: true });
  const root = document.documentElement;
  if (!root.requestFullscreen || document.fullscreenElement) return;
  void root
    .requestFullscreen()
    .then(() => keyboard()?.lock?.(["Escape"]))
    .catch(() => undefined);
}

/** Si se sale de la pantalla completa del navegador (Esc), también de la vista sin paneles. */
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
