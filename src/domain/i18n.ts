import { en } from "./i18n/en.ts";

/**
 * Stateless interface translation uses Spanish source text as keys and falls back to it when
 * untranslated. Named placeholders also identify already-interpolated server messages through
 * patterns.
 */

export type Locale = "es" | "en";

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "es", label: "Español" },
  { id: "en", label: "English" },
];

export function isLocale(value: unknown): value is Locale {
  return value === "es" || value === "en";
}

const catalogs: Record<Exclude<Locale, "es">, Record<string, string>> = { en };

type Pattern = { regex: RegExp; names: string[]; target: string };
const patterns = new Map<Locale, Pattern[]>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(locale: Exclude<Locale, "es">): Pattern[] {
  const cached = patterns.get(locale);
  if (cached) return cached;
  const list: Pattern[] = [];
  for (const [source, target] of Object.entries(catalogs[locale])) {
    if (!/\{\w+\}/.test(source)) continue;
    const names: string[] = [];
    const parts = source.split(/(\{\w+\})/);
    const body = parts
      .map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        if (!name) return escapeRegex(part);
        names.push(name);
        return "([\\s\\S]+?)";
      })
      .join("");
    list.push({ regex: new RegExp(`^${body}$`), names, target });
  }
  // Try more specific patterns with more literal text first.
  list.sort((a, b) => b.regex.source.length - a.regex.source.length);
  patterns.set(locale, list);
  return list;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function translate(
  locale: Locale,
  text: string,
  vars?: Record<string, string | number>,
): string {
  if (locale === "es" || !text) return vars ? fill(text, vars) : text;
  const catalog = catalogs[locale];
  const direct = catalog[text];
  if (direct !== undefined) return vars ? fill(direct, vars) : direct;
  if (!vars) {
    for (const pattern of compile(locale)) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const found: Record<string, string> = {};
      pattern.names.forEach((name, index) => {
        found[name] = match[index + 1] ?? "";
      });
      return fill(pattern.target, found);
    }
  }
  return vars ? fill(text, vars) : text;
}

/** Intl locale for dates and numbers. */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en" : "es";
}
