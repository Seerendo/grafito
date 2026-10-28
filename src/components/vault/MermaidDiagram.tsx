import { useEffect, useId, useState } from "react";
import { isLightTheme } from "@/app/theme";
import { t } from "@/app/i18n";
import { quoteFlowchartLabels } from "@/domain/vault/mermaid-fix";

export function MermaidDiagram({ chart, variant = "app" }: { chart: string; variant?: "app" | "print" }) {
  const reactId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "default">(variant === "print" || isLightTheme() ? "default" : "dark");

  useEffect(() => {
    if (variant === "print") {
      setTheme("default");
      return;
    }
    const read = () => setTheme(isLightTheme() ? "default" : "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [variant]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // Ni imágenes en las etiquetas: en una nota compartida servirían de
          // píxel de rastreo hacia otro servidor.
          dompurifyConfig: { FORBID_TAGS: ["img", "image"] },
          theme,
          fontFamily: variant === "print" ? "Georgia, serif" : "Outfit, sans-serif",
          suppressErrorRendering: true,
          flowchart: { htmlLabels: false },
        });
        const id = `grafito${reactId}${theme}${variant}`;
        const source = chart.trim();
        let rendered: { svg: string };
        try {
          rendered = await mermaid.render(id, source);
        } catch (error) {
          // Etiquetas con paréntesis u otros signos sin comillas: se reintenta con ellas.
          const quoted = quoteFlowchartLabels(source);
          if (quoted === source) throw error;
          rendered = await mermaid.render(`${id}q`, quoted).catch(() => {
            throw error;
          });
        }
        if (!cancelled) setSvg(rendered.svg);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t("Diagrama inválido"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, reactId, theme, variant]);

  if (error) {
    return (
      <pre data-mermaid-status="error" className="mt-4 overflow-x-auto rounded-lg bg-inset p-4 font-mono text-sm text-danger">
        {t(error)}
      </pre>
    );
  }
  if (!svg) {
    return (
      <p data-mermaid-status="pending" className="mt-4 font-sans text-sm text-faint">
        {t("Dibujando diagrama…")}
      </p>
    );
  }
  return (
    <div
      data-mermaid-status="ready"
      className="mt-4 overflow-x-auto rounded-lg bg-inset p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
