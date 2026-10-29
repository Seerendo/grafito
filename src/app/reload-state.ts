import { useEffect, useRef } from "react";

/**
 * Dónde estaba una pantalla, solo para recargar la página: se guarda al
 * descargarse (`pagehide`) o justo antes de que la aplicación se vuelva a
 * montar (al cambiar de idioma, `keepForRemount`), y se lee una sola vez al
 * volver. Salir de la pantalla de otra forma (el logo, un enlace) no guarda
 * nada, así que al entrar de nuevo empieza desde el principio.
 */

const REMOUNT = "grafito:before-remount";

/** Lo guardado para `key` (sin borrarlo aún: lo borra `useSaveOnReload` al montarse). */
export function readReloadState<T>(key: string): T | null {
  try {
    const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Guarda `value` en `key` solo si la página se recarga o la aplicación se vuelve a montar. */
export function useSaveOnReload(key: string, value: unknown): void {
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    // Ya leído al montarse: entrar otra vez después empieza de cero.
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* sin almacenamiento */
    }
    const save = () => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(latest.current));
      } catch {
        /* solo es una comodidad */
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

/** Avisa de que la aplicación se va a volver a montar (cambio de idioma): las pantallas guardan dónde estaban. */
export function keepForRemount(): void {
  window.dispatchEvent(new Event(REMOUNT));
}
