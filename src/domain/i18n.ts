import { en } from "./i18n/en.ts";

/**
 * Traducción de la interfaz (lógica pura, sin estado). El texto en español es
 * la clave: `translate("en", "Guardar")` → "Save". Lo que no tiene traducción
 * se queda en español.
 *
 * Variables: `{nombre}` en la clave y en la traducción. Los mensajes que llegan
 * ya armados del servidor («Conecta Ollama en tu cuenta…») se reconocen con
 * esas mismas claves como patrones.
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
  // Los patrones más específicos (más texto fijo) primero.
  list.sort((a, b) => b.regex.source.length - a.regex.source.length);
  patterns.set(locale, list);
  return list;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
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

/** Locale de `Intl` para fechas y números. */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en" : "es";
}
