import type { ReactNode } from "react";

/** Diálogo modal: abajo en móvil, centrado en escritorio. Clic fuera lo cierra. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-inset/80 p-4 sm:items-center" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-line bg-surface p-4 shadow-2xl"
      >
        <h2 className="font-serif text-2xl">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
