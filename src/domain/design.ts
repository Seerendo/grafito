/**
 * Diseño de la interfaz, para toda la instalación (lo elige el administrador).
 * Los temas de color se aplican sobre cualquiera de los dos: el diseño solo
 * cambia formas, profundidad y disposición, y toma los colores y las
 * tipografías del tema (`--color-*`, `--font-*`).
 *
 * - `modern` → «Cristal» (por defecto): paneles flotantes de vidrio. Se llamaba
 *   «Moderno»; el identificador se conserva para no cambiar lo guardado.
 *   Ver `src/design-modern.css`.
 * - `classic` → «Clásico»: la interfaz base, sin capa.
 */
export const DESIGN_IDS = ["modern", "classic"] as const;

export type Design = (typeof DESIGN_IDS)[number];

export const DEFAULT_DESIGN: Design = "modern";

export const DESIGNS: { id: Design; label: string; description: string }[] = [
  { id: "modern", label: "Cristal", description: "Paneles flotantes de vidrio, formas de píldora y un brillo del acento." },
  { id: "classic", label: "Clásico", description: "La interfaz original, plana y sin capas." },
];

export function isDesign(value: unknown): value is Design {
  return typeof value === "string" && (DESIGN_IDS as readonly string[]).includes(value);
}
