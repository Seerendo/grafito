import { Maximize2, Minimize2 } from "lucide-react";
import { useFullscreen } from "@/app/fullscreen";
import { t } from "@/app/i18n";

/** Botón de pantalla completa de una nota o un archivo (ver `app/fullscreen.ts`). */
export function FullscreenButton({ className = "" }: { className?: string }) {
  const on = useFullscreen((state) => state.on);
  const toggle = useFullscreen((state) => state.toggle);
  const label = on ? t("Salir de pantalla completa") : t("Pantalla completa");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={toggle}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-md ${on ? "text-accent" : "text-muted hover:text-fg"} ${className}`}
    >
      {on ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
    </button>
  );
}
