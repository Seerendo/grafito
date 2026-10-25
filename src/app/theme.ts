export type ThemeId =
  | "grafito"
  | "papel"
  | "terminal"
  | "taller"
  | "marea"
  | "cine"
  | "manuscrito"
  | "plano"
  | "invernadero"
  | "folleto";

export type ThemeTone = "dark" | "light";

export const THEMES: {
  id: ThemeId;
  name: string;
  ink: string;
  tone: ThemeTone;
  blurb: string;
}[] = [
  {
    id: "grafito",
    name: "Grafito",
    ink: "#12110e",
    tone: "dark",
    blurb: "Mesa de editorial: oscuro cálido, serif y un ámbar de lápiz.",
  },
  {
    id: "papel",
    name: "Papel",
    ink: "#f4efe4",
    tone: "light",
    blurb: "Cuaderno claro, esquinas rectas y tinta de imprenta.",
  },
  {
    id: "terminal",
    name: "Terminal",
    ink: "#070a07",
    tone: "dark",
    blurb: "Fósforo verde, monoespaciada, sin un solo redondeo.",
  },
  {
    id: "taller",
    name: "Taller",
    ink: "#241910",
    tone: "dark",
    blurb: "Madera y cobre, esquinas blandas de banco de trabajo.",
  },
  {
    id: "marea",
    name: "Marea",
    ink: "#07141c",
    tone: "dark",
    blurb: "Agua profunda, teal y curvas amplias.",
  },
  {
    id: "cine",
    name: "Cine",
    ink: "#090909",
    tone: "dark",
    blurb: "Sala a oscuras, rótulo rojo y encuadre cuadrado.",
  },
  {
    id: "manuscrito",
    name: "Manuscrito",
    ink: "#fbf6ec",
    tone: "light",
    blurb: "Hoja rayada, lectura en serif y margen de vino.",
  },
  {
    id: "plano",
    name: "Plano",
    ink: "#e7f0f6",
    tone: "light",
    blurb: "Mesa de dibujo: cuadrícula, cian técnico y mono.",
  },
  {
    id: "invernadero",
    name: "Invernadero",
    ink: "#101c16",
    tone: "dark",
    blurb: "Noche vegetal, cal viva y vidrio redondeado.",
  },
  {
    id: "folleto",
    name: "Folleto",
    ink: "#f3ecdf",
    tone: "light",
    blurb: "Risografía: crema, magenta y un azul de impresión.",
  },
];

const THEME_STORAGE_KEY = "grafito.theme";
const KNOWN = new Set<string>(THEMES.map((theme) => theme.id));

/**
 * Script inline para `<head>`: aplica el tema guardado antes del primer pintado
 * (sin destello). Se genera desde `THEMES` para no duplicar la tabla a mano.
 */
export function themeBootScript(): string {
  const ink = Object.fromEntries(THEMES.map((theme) => [theme.id, theme.ink]));
  const light = THEMES.filter((theme) => theme.tone === "light").map((theme) => theme.id);
  return `(function(){try{var map={dark:"grafito",light:"papel"};var ink=${JSON.stringify(ink)};var light=${JSON.stringify(light)};var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||"grafito";if(map[t])t=map[t];if(!ink[t])t="grafito";var d=document.documentElement;d.dataset.theme=t;d.dataset.tone=light.indexOf(t)>=0?"light":"dark";var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",ink[t]);}catch(e){}})();`;
}

export function normalizeTheme(value: string | null | undefined): ThemeId {
  if (value === "dark") return "grafito";
  if (value === "light") return "papel";
  if (value && KNOWN.has(value)) return value as ThemeId;
  return "grafito";
}

export function currentTheme(): ThemeId {
  if (typeof document === "undefined") return "grafito";
  return normalizeTheme(document.documentElement.dataset.theme);
}

export function isLightTheme(id?: string | null): boolean {
  const theme = THEMES.find((item) => item.id === normalizeTheme(id ?? currentTheme()));
  return theme?.tone === "light";
}

export function applyTheme(id: ThemeId) {
  const theme = THEMES.find((item) => item.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.tone = theme.tone;
  localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.ink);
}

export function cycleTheme() {
  const index = THEMES.findIndex((theme) => theme.id === currentTheme());
  const next = THEMES[(index + 1) % THEMES.length] ?? THEMES[0];
  applyTheme(next.id);
}

export function toggleTheme() {
  cycleTheme();
}
