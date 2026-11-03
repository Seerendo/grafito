/**
 * Administrator-selected installation layout. Both designs use theme colors/fonts. modern
 * retains its persisted identifier for Crystal, formerly Modern, with floating glass panels;
 * see design-modern.css. classic uses the base UI.
 */
export const DESIGN_IDS = ["modern", "classic"] as const;

export type Design = (typeof DESIGN_IDS)[number];

export const DEFAULT_DESIGN: Design = "modern";

export const DESIGNS: { id: Design; label: string; description: string }[] = [
  {
    id: "modern",
    label: "Cristal",
    description: "Paneles flotantes de vidrio, formas de píldora y un brillo del acento.",
  },
  { id: "classic", label: "Clásico", description: "La interfaz original, plana y sin capas." },
];

export function isDesign(value: unknown): value is Design {
  return typeof value === "string" && (DESIGN_IDS as readonly string[]).includes(value);
}
