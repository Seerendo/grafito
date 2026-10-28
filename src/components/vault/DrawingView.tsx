import { useEffect, useRef, useState, type ComponentType } from "react";
import { readDrawing, saveDrawing } from "@/server/drawing.functions";
import { useVault } from "@/app/vault/store";
import { bearerHeader } from "@/lib/auth/bearer";
import { findByTitle } from "@/domain/vault/links";
import { getLocale, t } from "@/app/i18n";

/**
 * Dibujo de Excalidraw (un archivo `.excalidraw`). Con permiso de edición se
 * dibuja aquí mismo y se guarda casi en tiempo real (`saveDrawing`): poco
 * después de cada cambio y, mientras se sigue dibujando, al menos cada dos
 * segundos; lo pendiente se guarda también al cerrar el dibujo o cambiar de
 * pestaña. Cada guardado es una versión nueva del archivo (agrupadas).
 *
 * Se lee del servidor (`readDrawing`), no por el enlace firmado del archivo:
 * cada guardado deja el dibujo en otro objeto y borra el anterior.
 *
 * Excalidraw y sus fuentes se cargan solo al abrir un dibujo y desde Grafito,
 * sin internet (`vite.config.ts` copia las fuentes a `/excalidraw/`).
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

/** Espera tras un cambio antes de guardar… */
const SAVE_DELAY_MS = 600;
/** …salvo si ya lleva este tiempo sin guardarse (se sigue dibujando). */
const SAVE_MAX_WAIT_MS = 2000;

/** Lo que el navegador deja mandar con `keepalive` al cerrar la página (64 KB, con margen). */
const KEEPALIVE_MAX = 60_000;

/** Si el tema de Grafito es oscuro (por la luminosidad de su fondo). */
function darkTheme(): boolean {
  const color = getComputedStyle(document.body).backgroundColor;
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  const [r = 255, g = 255, b = 255] = parts;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * Lo que de verdad cambia el dibujo: sus elementos (cada uno lleva su
 * versión), las imágenes y el color del lienzo. Mover o acercar la vista no
 * cuenta, así que no provoca guardados.
 */
function sceneKey(lib: Lib, elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>): string {
  return `${lib.getSceneVersion(elements as never)}|${elements.length}|${Object.keys(files).length}|${String(appState.viewBackgroundColor ?? "")}`;
}

export function DrawingView({
  docId,
  shareId,
  canEdit,
  onSaved,
  onOpenNote,
}: {
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
  const savedKey = useRef("");
  const pending = useRef<{ key: string; content: string } | null>(null);
  const waitingSince = useRef(0);
  const timer = useRef(0);
  const saving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setScene(null);
    setError("");
    setStatus("");
    pending.current = null;
    void (async () => {
      try {
        const [loaded, result] = await Promise.all([
          loadExcalidraw(),
          readDrawing({ data: { docId, ...(shareId ? { shareId } : {}) } }),
        ]);
        if (!result.ok) throw new Error(result.error);
        const restored = loaded.restore(JSON.parse(result.content) as never, null, null);
        if (cancelled) return;
        savedKey.current = sceneKey(loaded, restored.elements, restored.appState as never, restored.files as never);
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
  }, [docId, shareId]);

  /** Guarda lo pendiente; si cambia mientras se guarda, vuelve a guardar al terminar. */
  const flush = async () => {
    window.clearTimeout(timer.current);
    if (saving.current || !pending.current) return;
    saving.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        waitingSince.current = 0;
        if (next.key === savedKey.current) continue;
        setStatus("saving");
        const result = await saveDrawing({ data: { docId, content: next.content, ...(shareId ? { shareId } : {}) } });
        if (!result.ok) {
          setStatus("error");
          setError(result.error);
          return;
        }
        savedKey.current = next.key;
      }
      setStatus("saved");
      onSaved?.();
    } catch {
      setStatus("error");
    } finally {
      saving.current = false;
      // Llegó otro cambio justo al terminar.
      if (pending.current) timer.current = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Al cerrar el dibujo, cambiar de pestaña o salir de la página: lo pendiente, ya.
  useEffect(() => {
    const now = () => void flushRef.current();
    const onHidden = () => {
      if (document.visibilityState === "hidden") now();
    };
    // Al cerrar o recargar, una petición normal se cancela con la página: lo
    // pendiente sale con `keepalive` (`POST /api/drawings/:id`), que la sobrevive.
    const onLeave = () => {
      const next = pending.current;
      if (!next || next.key === savedKey.current || saving.current) return now();
      if (next.content.length > KEEPALIVE_MAX) return now();
      pending.current = null;
      savedKey.current = next.key;
      window.clearTimeout(timer.current);
      void fetch(`/api/drawings/${encodeURIComponent(docId)}`, {
        method: "POST",
        keepalive: true,
        credentials: "include",
        headers: { "content-type": "application/json", ...bearerHeader() },
        body: JSON.stringify({ content: next.content, ...(shareId ? { shareId } : {}) }),
      }).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
      now();
    };
  }, [docId, shareId]);

  if (error && !scene) return <p className="text-sm text-danger">{error}</p>;
  if (!lib || !scene) return <p className="text-sm text-faint">{t("Cargando…")}</p>;

  const Excalidraw = lib.Excalidraw as unknown as ComponentType<Record<string, unknown>>;
  const Menu = lib.MainMenu;
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
        UIOptions={UI_OPTIONS}
        onChange={(elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => {
          if (!canEdit) return;
          const key = sceneKey(lib, elements, appState, files);
          if (key === savedKey.current && !pending.current) return;
          pending.current = { key, content: lib.serializeAsJSON(elements as never, appState as never, files as never, "local") };
          const started = waitingSince.current || Date.now();
          waitingSince.current = started;
          window.clearTimeout(timer.current);
          const late = Date.now() - started >= SAVE_MAX_WAIT_MS;
          timer.current = window.setTimeout(() => void flushRef.current(), late ? 0 : SAVE_DELAY_MS);
        }}
        onLinkOpen={(element: { link?: string | null }, event: CustomEvent<{ nativeEvent: Event }>) => {
          const target = element.link ? openLink(element.link) : null;
          if (!target || !onOpenNote) return;
          event.preventDefault();
          void flushRef.current();
          onOpenNote(target);
        }}
      >
        {/* El menú de Grafito: sin los enlaces de Excalidraw (GitHub, redes) ni abrir o guardar archivos sueltos. */}
        <Menu>
          <Menu.DefaultItems.SaveAsImage />
          <Menu.DefaultItems.SearchMenu />
          <Menu.DefaultItems.Help />
          <Menu.DefaultItems.ClearCanvas />
          <Menu.Separator />
          <Menu.DefaultItems.ChangeCanvasBackground />
        </Menu>
      </Excalidraw>
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

/** Fuera del componente: el mismo objeto en cada render. */
const UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } };
