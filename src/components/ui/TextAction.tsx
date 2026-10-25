import type { ReactNode } from "react";

/** Acción secundaria presentada como texto (p. ej. "Eliminar"), no como botón con caja. */
export function TextAction({
  children,
  onClick,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "muted" | "danger";
  className?: string;
}) {
  const color = tone === "danger" ? "text-danger" : "text-muted hover:text-fg";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 text-sm underline-offset-4 hover:underline ${color} ${className}`}
    >
      {children}
    </button>
  );
}
