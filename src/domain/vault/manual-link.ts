import { linkKey, type TextAnchor } from "./anchor.ts";
import type { ManualLink } from "./types.ts";

/** Tope de vínculos manuales de un documento, para no inflar lo compartido. */
export const MAX_MANUAL_LINKS = 200;

/**
 * Añade un vínculo, o sustituye el que ya apunta a lo mismo (mismo destino y
 * ancla). `full` si ya hay demasiados y este es nuevo.
 */
export function withManualLink(links: readonly ManualLink[], added: ManualLink): ManualLink[] | "full" {
  const key = linkKey(added);
  const rest = links.filter((link) => linkKey(link) !== key);
  if (rest.length >= MAX_MANUAL_LINKS) return "full";
  return [...rest, added];
}

/** Quita el vínculo con ese destino y, si lo tiene, esa ancla. */
export function withoutManualLink(
  links: readonly ManualLink[],
  removed: { targetId: string; anchor?: TextAnchor },
): ManualLink[] {
  const key = linkKey(removed);
  return links.filter((link) => linkKey(link) !== key);
}
