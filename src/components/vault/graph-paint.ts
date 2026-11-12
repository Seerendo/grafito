/**
 * Colours of the graph, read from the theme, shared by the 2D (cosmos.gl) and 3D (three.js)
 * views so both look alike.
 */

export type Paint = {
  accent: Rgba;
  fg: Rgba;
  muted: string;
  faint: Rgba;
  line: Rgba;
  elevated: Rgba;
  ink: string;
  accentText: string;
};

export type Rgba = [number, number, number, number];

export function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Any CSS color as RGBA floats, read back through a 2D context. */
let probeContext: CanvasRenderingContext2D | null = null;

export function rgba(color: string, alpha = 1): Rgba {
  // One small canvas reads every colour; a new one per colour was slow when repainting often.
  probeContext ??= document.createElement("canvas").getContext("2d");
  const probe = probeContext;
  if (!probe) return [1, 1, 1, alpha];
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  const value = String(probe.fillStyle);
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      alpha,
    ];
  }
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255, 1];
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, (parts[3] ?? 1) * alpha];
}

/** Twelve hues, lighter on a dark page and darker on a light one. */
const HUES = [205, 145, 330, 45, 265, 175, 15, 95, 295, 230, 120, 355];

export function communityPalette(): Rgba[] {
  const background = rgba(cssColor("--color-bg", "#141210"));
  const light = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2] > 0.5;
  return HUES.map((hue) => rgba(`hsl(${hue} ${light ? 55 : 50}% ${light ? 42 : 62}%)`));
}

export function readPaint(): Paint {
  const accent = cssColor("--color-accent", "#e0a14a");
  return {
    accent: rgba(accent),
    fg: rgba(cssColor("--color-fg", "#f3eee6")),
    muted: cssColor("--color-muted", "#a89b8c"),
    faint: rgba(cssColor("--color-faint", "#746a5e")),
    // Links in the faint text colour: the border colour vanished on dark themes.
    line: rgba(cssColor("--color-faint", "#746a5e"), 0.55),
    elevated: rgba(cssColor("--color-elevated", "#26231d")),
    ink: cssColor("--color-accent-fg", "#1c1408"),
    accentText: accent,
  };
}
