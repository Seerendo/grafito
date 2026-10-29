import { useState, type MouseEvent } from "react";
import { ContextMenu, type ContextItem, type ContextMenuState } from "./ContextMenu";

/**
 * Menú de clic derecho (el mismo aspecto que el del directorio, `RowMenu`):
 * se abre donde se pulsó, sin salirse de la ventana, y se cierra con Esc, un
 * clic fuera, al desplazar o al elegir.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const open = (event: MouseEvent, items: ContextItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    if (items.length > 0) setMenu({ x: event.clientX, y: event.clientY, items });
  };
  /** Para abrirlo después de esperar algo (el evento ya pasó): en un punto de la pantalla. */
  const openAt = (x: number, y: number, items: ContextItem[]) => {
    if (items.length > 0) setMenu({ x, y, items });
  };
  const element = menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null;
  return { open, openAt, close: () => setMenu(null), element };
}
