import { useEffect, useRef, useState, type ComponentType } from "react";
import { saveDrawing } from "@/server/drawing.functions";
import { useVault } from "@/app/vault/store";
import { findByTitle } from "@/domain/vault/links";
import { getLocale, t } from "@/app/i18n";

/**
 * Dibujo de Excalidraw (un archivo `.excalidraw`). Con permiso de edición se
 * dibuja aquí mismo y se guarda solo, unos segundos después de cada cambio,
 * como una versión nueva del archivo (`saveDrawing`). Excalidraw y sus
 * fuentes se cargan solo al abrir un dibujo y desde Grafito, sin internet
 * (`vite.config.ts` copia las fuentes a `/excalidraw/`).
 *
 * El enlace de un elemento (Ctrl+K en Excalidraw) puede ser el título de una
 * nota, `[[Título]]`, o su id: al abrirlo se abre esa nota en Grafito.
 */

type Lib = typeof import("@excalidraw/excalidraw");
type Scene = { elements: readonly unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> };

let loader: Promise<Lib> | null = null;

function loadExcalidraw(): Promise<Lib> {
  // Solo en el navegador: el build del servidor no debe incluir Excalidraw
  // (usa `window` al cargarse). `import.meta.env.SSR` lo quita al construir.
  if (import.meta.env.SSR) return Promise.reject(new Error("Excalidraw solo en el navegador"));
  loader ??= (async () => {
    (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = `${window.location.origin}/excalidraw/`;
    await import("@excalidraw/excalidraw/index.css");
    return import("@excalidraw/excalidraw");
  })();
  return loader;
}

/** Espera tras el último cambio antes de guardar. */
const SAVE_DELAY_MS = 2000;

/** Si el tema de Grafito es oscuro (por la luminosidad de su fondo). */
function darkTheme(): boolean {
  const color = getComputedStyle(document.body).backgroundColor;
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  const [r = 255, g = 255, b = 255] = parts;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

export function DrawingView({
  url,
  docId,
  shareId,
  canEdit,
  onSaved,
  onOpenNote,
}: {
  url: string;
  docId: string;
  shareId?: string;
  canEdit: boolean;
  onSaved?: () => void;
  onOpenNote?: (id: string) => void;
}) {
  const [lib, setLib] = useState<Lib | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"" | "saving" | "saved" | "error">("");
  const lastSaved = useRef("");
  const pending = useRef<string | null>(null);
  const timer = useRef(0);
  const urlRef = useRef(url);

  // El dibujo se lee una vez por documento: al guardar cambia la dirección
  // firmada del archivo, y volver a leerlo deshace lo que se está dibujando.
  useEffect(() => {
    let cancelled = false;
    setScene(null);
    setError("");
    void (async () => {
      try {
        const [loaded, response] = await Promise.all([loadExcalidraw(), fetch(urlRef.current, { credentials: "include" })]);
        if (!response.ok) throw new Error(String(response.status));
        const text = await response.text();
        const data = JSON.parse(text) as Partial<Scene>;
        const restored = loaded.restore(data as never, null, null);
        if (cancelled) return;
        lastSaved.current = loaded.serializeAsJSON(restored.elements, restored.appState, restored.files, "local");
        setLib(loaded);
        setScene({
          elements: restored.elements,
          appState: { ...restored.appState, collaborators: new Map() },
          files: restored.files,
        });
      } catch {
        if (!cancelled) setError(t("No se pudo abrir el dibujo."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const content = pending.current;
    pending.current = null;
    if (!content || content === lastSaved.current) return;
    setStatus("saving");
    try {
      const result = await saveDrawing({ data: { docId, content, ...(shareId ? { shareId } : {}) } });
      if (!result.ok) {
        setStatus("error");
        setError(result.error);
        return;
      }
      lastSaved.current = content;
      setStatus("saved");
      onSaved?.();
    } catch {
      setStatus("error");
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Al cambiar de documento o salir, se guarda lo pendiente.
  useEffect(() => () => void flushRef.current(), [docId]);

  if (error && !scene) return <p className="text-sm text-danger">{error}</p>;
  if (!lib || !scene) return <p className="text-sm text-faint">{t("Cargando…")}</p>;

  const Excalidraw = lib.Excalidraw as unknown as ComponentType<Record<string, unknown>>;
  const openLink = (link: string): string | null => {
    const key = link.replace(/^\[\[|\]\]$/g, "").replace(/^https?:\/\//, "").trim();
    const documents = useVault.getState().documents;
    const target = documents.find((item) => item.id === key) ?? findByTitle(documents, key);
    return target?.id ?? null;
  };

  return (
    <div data-ui="drawing" className="relative h-full min-h-[60vh] overflow-hidden rounded-md border border-line">
      <Excalidraw
        initialData={scene}
        viewModeEnabled={!canEdit}
        theme={darkTheme() ? "dark" : "light"}
        langCode={getLocale() === "en" ? "en" : "es-ES"}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
        onChange={(elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => {
          if (!canEdit) return;
          const content = lib.serializeAsJSON(elements as never, appState as never, files as never, "local");
          if (content === lastSaved.current) return;
          pending.current = content;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
        }}
        onLinkOpen={(element: { link?: string | null }, event: CustomEvent<{ nativeEvent: Event }>) => {
          const target = element.link ? openLink(element.link) : null;
          if (!target || !onOpenNote) return;
          event.preventDefault();
          void flushRef.current();
          onOpenNote(target);
        }}
      />
      {canEdit && status ? (
        <span
          className={`pointer-events-none absolute right-3 bottom-3 z-10 rounded-full bg-surface/90 px-2.5 py-1 text-xs ${
            status === "error" ? "text-danger" : "text-muted"
          }`}
        >
          {status === "saving" ? t("Guardando…") : status === "saved" ? t("Guardado") : error || t("No se pudo guardar.")}
        </span>
      ) : null}
    </div>
  );
}
