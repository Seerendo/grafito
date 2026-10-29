import type { ReactNode } from "react";

/** Acción secundaria presentada como texto (p. ej. "Eliminar"), no como botón con caja. */
export function TextAction({
  children,
  onClick,
  tone = "muted",
  className = "",
  menuLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "muted" | "danger";
  className?: string;
  /** Su nombre en el menú de clic derecho del panel, si el texto no basta (ver `useAutoContextMenu`). */
  menuLabel?: string;
}) {
  const color = tone === "danger" ? "text-danger" : "text-muted hover:text-fg";
  return (
    <button
      type="button"
      onClick={onClick}
      // Con el ratón (también el clic derecho) no se queda con el foco: si no,
      // una tecla después le dibuja el anillo. Con Tab sí se llega a él.
      onMouseDown={(event) => event.preventDefault()}
      data-menu-label={menuLabel}
      className={`shrink-0 text-sm underline-offset-4 hover:underline ${color} ${className}`}
    >
      {children}
    </button>
  );
}
