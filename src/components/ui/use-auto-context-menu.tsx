import type { MouseEvent } from "react";
import type { ContextItem } from "./ContextMenu";
import { useContextMenu } from "./use-context-menu";

/**
 * Derive context menus from existing panel buttons. Row targets use row actions; other areas
 * use panel actions outside rows. Explicit row menus retain priority, and text fields keep
 * browser menus. Omit ordinary navigation, selection, toggles and expand/collapse actions.
 * data-menu-label overrides wording; data-menu-skip excludes a button.
 */

const ROW = "li, tr, [data-menu-row]";
const MAX_ITEMS = 14;
/** Selection, view switching and collapsing already use a normal click. */
const OBVIOUS =
  "[role='tab'], [role='switch'], [role='radio'], [role='option'], [aria-pressed], [aria-selected], [aria-expanded], [aria-current]";

function labelOf(button: HTMLElement): string {
  const explicit =
    button.dataset.menuLabel ?? button.getAttribute("aria-label") ?? button.getAttribute("title");
  if (explicit) return explicit.trim();
  const text = button.innerText.trim();
  // Multiline cards such as themes or users are selected with one click.
  if (text.includes("\n")) return "";
  return text.replace(/\s+/g, " ");
}

function usable(button: HTMLElement): boolean {
  if (button.closest("[role='menu'], [data-menu-skip]")) return false;
  if ((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true")
    return false;
  // Visible, neither collapsed nor hidden.
  return button.getClientRects().length > 0;
}

function collect(scope: HTMLElement, insideRow: boolean, panel: HTMLElement): ContextItem[] {
  const seen = new Set<string>();
  const items: ContextItem[] = [];
  for (const button of scope.querySelectorAll<HTMLElement>("button")) {
    if (!usable(button) || button.matches(OBVIOUS)) continue;
    // General panel actions exclude buttons inside rows.
    if (!insideRow) {
      const row = button.closest(ROW);
      if (row && panel.contains(row)) continue;
    }
    // A row that is itself a button opens with a normal click.
    if (insideRow && button.innerText.trim() === scope.innerText.trim()) continue;
    const label = labelOf(button);
    if (!label || label.length > 60 || seen.has(label)) continue;
    seen.add(label);
    const danger =
      /\btext-danger\b|\bbg-danger\b/.test(button.className) ||
      button.dataset.menuDanger !== undefined;
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
