import { useSyncExternalStore } from "react";
import { intlLocale, isLocale, translate, type Locale } from "@/domain/i18n";

/**
 * Client interface language. t translates through domain/i18n.ts. A cookie keeps SSR language
 * consistent, and account preferences synchronize it across browsers. Changing language
 * remounts the app through routes/__root.tsx.
 */

export const LOCALE_COOKIE = "grafito-locale";

let current: Locale = "es";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** Set language silently before the root renders. */
export function applyLocale(locale: Locale): void {
  current = locale;
}

/** Change language, persist its cookie and rerender the app. */
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

/** Intl locale for dates and numbers in the current language. */
export function intl(): string {
  return intlLocale(current);
}
