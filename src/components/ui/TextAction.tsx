import type { ReactNode } from "react";

/** Secondary action displayed as text instead of a boxed button. */
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
  /** Optional context-menu label when visible text is insufficient; see useAutoContextMenu. */
  menuLabel?: string;
}) {
  const color = tone === "danger" ? "text-danger" : "text-muted hover:text-fg";
  return (
    <button
      type="button"
      onClick={onClick}
      // Pointer clicks, including right-clicks, do not retain focus; Tab navigation remains available.
      onMouseDown={(event) => event.preventDefault()}
      data-menu-label={menuLabel}
      className={`shrink-0 text-sm underline-offset-4 hover:underline ${color} ${className}`}
    >
      {children}
    </button>
  );
}
