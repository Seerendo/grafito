/**
 * Diseño de la interfaz: «Moderno» (por defecto) o «Clásico». Lo elige el
 * administrador para toda la instalación; los temas de color se aplican sobre
 * cualquiera de los dos (ver `src/design-modern.css`).
 */
export type Design = "modern" | "classic";

export const DEFAULT_DESIGN: Design = "modern";

export const DESIGNS: { id: Design; label: string }[] = [
  { id: "modern", label: "Moderno" },
  { id: "classic", label: "Clásico" },
];

export function isDesign(value: unknown): value is Design {
  return value === "modern" || value === "classic";
}
