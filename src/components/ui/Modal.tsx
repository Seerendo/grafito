import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Diálogo modal: abajo en móvil, centrado en escritorio. Clic fuera lo cierra.
 * Se dibuja en el `body`: dentro de un panel con `backdrop-filter` (diseño
 * Cristal) un `position: fixed` queda encerrado en el panel y el diálogo salía
 * centrado en él, no en la ventana.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = (
    <div data-ui="overlay" className="fixed inset-0 z-50 flex items-end justify-center bg-inset/80 p-4 sm:items-center" onMouseDown={onClose}>
      <div
        role="dialog"
        data-ui="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className={`max-h-[85vh] w-full overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-2xl ${wide ? "max-w-4xl" : "max-w-md"}`}
      >
        <h2 className="font-serif text-2xl">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
