import type { MouseEvent } from "react";
import type { ContextItem } from "./ContextMenu";
import { useContextMenu } from "./use-context-menu";

/**
 * Clic derecho en cualquier parte de un panel, con las mismas acciones que sus
 * botones: sobre una fila (`li`, `tr` o `[data-menu-row]`), las de esa fila; en
 * el resto, las generales del panel (las que no están dentro de una fila). Así
 * cada pantalla tiene por clic derecho lo mismo que por botones, sin una lista
 * aparte que mantener. Los menús propios de una fila (que paran el evento)
 * siguen mandando, y en un campo de texto se respeta el menú del navegador.
 *
 * Solo acciones: lo que ya es evidente con un clic queda fuera (abrir una
 * fila, cambiar de pestaña, elegir una tarjeta, encender un interruptor,
 * plegar o desplegar). Un botón puede dar otro nombre para el menú con
 * `data-menu-label`, o quedarse fuera con `data-menu-skip`.
 */

const ROW = "li, tr, [data-menu-row]";
const MAX_ITEMS = 14;
/** Elegir, cambiar de vista o plegar: se hace con un clic, no hace falta en el menú. */
const OBVIOUS =
  "[role='tab'], [role='switch'], [role='radio'], [role='option'], [aria-pressed], [aria-selected], [aria-expanded], [aria-current]";

function labelOf(button: HTMLElement): string {
  const explicit = button.dataset.menuLabel ?? button.getAttribute("aria-label") ?? button.getAttribute("title");
  if (explicit) return explicit.trim();
  const text = button.innerText.trim();
  // Una tarjeta con varias líneas (un tema, un usuario…) se elige con un clic.
  if (text.includes("\n")) return "";
  return text.replace(/\s+/g, " ");
}

function usable(button: HTMLElement): boolean {
  if (button.closest("[role='menu'], [data-menu-skip]")) return false;
  if ((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true") return false;
  // Visible (ni plegado ni oculto).
  return button.getClientRects().length > 0;
}

function collect(scope: HTMLElement, insideRow: boolean, panel: HTMLElement): ContextItem[] {
  const seen = new Set<string>();
  const items: ContextItem[] = [];
  for (const button of scope.querySelectorAll<HTMLElement>("button")) {
    if (!usable(button) || button.matches(OBVIOUS)) continue;
    // Las generales: las que no están dentro de ninguna fila del panel.
    if (!insideRow) {
      const row = button.closest(ROW);
      if (row && panel.contains(row)) continue;
    }
    // Una fila que es en sí un botón (un usuario de la lista): abrirla es un clic.
    if (insideRow && button.innerText.trim() === scope.innerText.trim()) continue;
    const label = labelOf(button);
    if (!label || label.length > 60 || seen.has(label)) continue;
    seen.add(label);
    const danger = /\btext-danger\b|\bbg-danger\b/.test(button.className) || button.dataset.menuDanger !== undefined;
    items.push({ label, danger, onClick: () => button.click() });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export function useAutoContextMenu() {
  const menu = useContextMenu();
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (window.getSelection()?.toString()) return;
    const panel = event.currentTarget;
    const row = target.closest<HTMLElement>(ROW);
    const inRow = row && panel.contains(row) ? collect(row, true, panel) : [];
    const items = inRow.length > 0 ? inRow : collect(panel, false, panel);
    if (items.length === 0) return;
    menu.open(event, items);
  };
  return { onContextMenu, element: menu.element };
}
