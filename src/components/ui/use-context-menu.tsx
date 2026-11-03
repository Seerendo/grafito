import { useState, type MouseEvent } from "react";
import { ContextMenu, type ContextItem, type ContextMenuState } from "./ContextMenu";

/** Viewport-clamped context menu matching RowMenu. Close on Esc, outside click, scrolling or selection. */
export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const open = (event: MouseEvent, items: ContextItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    if (items.length > 0) setMenu({ x: event.clientX, y: event.clientY, items });
  };
  /** Open at a viewport position after an asynchronous operation has outlived its original event. */
  const openAt = (x: number, y: number, items: ContextItem[]) => {
    if (items.length > 0) setMenu({ x, y, items });
  };
  const element = menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null;
  return { open, openAt, close: () => setMenu(null), element };
}
