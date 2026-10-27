import type { MouseEvent } from "react";

/**
 * Clics en huecos: la parte vacía de la barra superior, el espacio entre
 * paneles o el fondo de un diálogo. El navegador lleva ahí la selección de
 * texto al punto más cercano, que puede caer dentro de un campo (p. ej.
 * «Filtrar») y dejar un cursor parpadeando. En un hueco no se mueve la
 * selección y el campo que tuviera el foco lo suelta, como al hacer clic
 * fuera de él.
 */

/** Un hueco: ni un control ni un elemento con texto propio. */
export function isBlank(target: HTMLElement): boolean {
  if (target.closest("input, textarea, select, button, a, label, [contenteditable], [role=button], [tabindex]")) return false;
  return ![...target.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
}

export function releaseFocus(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * `onMouseDown` del marco de la app. No actúa dentro de los paneles de
 * contenido (la nota, los detalles, el chat), donde arrastrar desde un margen
 * sirve para seleccionar texto.
 */
export function releaseOnBlankFrame(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('[data-ui="workspace"], [data-ui="context"], [data-ui="chat"], [data-ui="dialog"], [data-ui="overlay"]')) return;
  if (!isBlank(target)) return;
  event.preventDefault();
  releaseFocus();
}
