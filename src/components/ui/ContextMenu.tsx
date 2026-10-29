import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Margen entre el menú y el borde de la ventana. */
const EDGE = 8;

export type ContextItem = { label: string; onClick: () => void; danger?: boolean };

export type ContextMenuState = { x: number; y: number; items: ContextItem[] } | null;

/** El menú abierto (ver `useContextMenu`). */
export function ContextMenu({ menu, onClose }: { menu: NonNullable<ContextMenuState>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: menu.x, top: menu.y, ready: false });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    let left = menu.x + box.width > window.innerWidth - EDGE ? menu.x - box.width : menu.x;
    let top = menu.y + box.height > window.innerHeight - EDGE ? menu.y - box.height : menu.y;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - box.width - EDGE));
    top = Math.max(EDGE, Math.min(top, window.innerHeight - box.height - EDGE));
    setPlace({ left, top, ready: true });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-ui="popover"
      className="fixed z-50 max-h-[calc(100dvh-1rem)] w-52 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-2xl"
      style={{ left: place.left, top: place.top, visibility: place.ready ? "visible" : "hidden" }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onClick();
          }}
          className={`flex h-10 w-full items-center rounded-md px-3 text-left text-sm hover:bg-elevated ${
            item.danger ? "text-danger" : "text-fg"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
