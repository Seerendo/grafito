import { useEffect, useState } from "react";
import { t } from "@/app/i18n";
import { DEFAULT_DESIGN, DESIGNS, isDesign, type Design } from "@/domain/design";
import { setDesign } from "@/server/design.functions";

/**
 * Administración → Apariencia → Diseño: Moderno o Clásico para toda la
 * instalación. Cada opción se dibuja en miniatura con los colores del tema
 * actual, porque los temas se aplican a los dos diseños.
 */
export function DesignPanel() {
  const [current, setCurrent] = useState<Design>(DEFAULT_DESIGN);
  const [error, setError] = useState("");

  useEffect(() => {
    const value = document.documentElement.dataset.design;
    setCurrent(isDesign(value) ? value : DEFAULT_DESIGN);
  }, []);

  const choose = async (design: Design) => {
    const previous = current;
    setError("");
    setCurrent(design);
    document.documentElement.dataset.design = design;
    try {
      const result = await setDesign({ data: { design } });
      if (!result.ok) throw new Error(result.error);
    } catch {
      setCurrent(previous);
      document.documentElement.dataset.design = previous;
      setError(t("No se pudo guardar."));
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {DESIGNS.map((design) => (
          <button
            key={design.id}
            type="button"
            aria-pressed={current === design.id}
            onClick={() => void choose(design.id)}
            className="theme-card"
          >
            <span className="design-preview" data-preview={design.id} aria-hidden="true">
              <i data-part="top" />
              <i data-part="side" />
              <i data-part="main">
                <i data-part="title" />
                <i data-part="line" />
                <i data-part="line" />
                <i data-part="button" />
              </i>
            </span>
            <span className="theme-card-copy">
              <strong className="text-sm">{t(design.label)}</strong>
              {current === design.id ? <em className="ml-2 text-xs text-accent not-italic">{t("En uso")}</em> : null}
              <small>{t(design.description)}</small>
            </span>
          </button>
        ))}
      </div>
      {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
    </div>
  );
}
