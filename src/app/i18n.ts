import { useSyncExternalStore } from "react";
import { intlLocale, isLocale, translate, type Locale } from "@/domain/i18n";

/**
 * Idioma de la interfaz en el cliente. `t("Guardar")` traduce al idioma
 * actual (ver `domain/i18n.ts`). El idioma vive en una cookie para que el
 * servidor pinte la primera página igual, y en las preferencias de la cuenta
 * para que siga al usuario en otros navegadores. Al cambiarlo, la raíz vuelve
 * a montar la aplicación (`routes/__root.tsx`).
 */

export const LOCALE_COOKIE = "grafito-locale";

let current: Locale = "es";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** Fija el idioma sin avisar (la raíz lo hace antes de pintar). */
export function applyLocale(locale: Locale): void {
  current = locale;
}

/** Cambia el idioma, lo recuerda en la cookie y repinta la aplicación. */
export function setLocale(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = locale;
  }
  if (locale === current) return;
  current = locale;
  listeners.forEach((listener) => listener());
}

export function localeFromCookie(header: string | null | undefined): Locale | null {
  const value = header
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === LOCALE_COOKIE)?.[1];
  return isLocale(value) ? value : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(current, text, vars);
}

/** Locale de `Intl` del idioma actual (fechas, números). */
export function intl(): string {
  return intlLocale(current);
}
