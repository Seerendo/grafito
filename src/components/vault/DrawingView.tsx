import { useEffect, useRef, useState, type ComponentType } from "react";
import { readDrawing, saveDrawing } from "@/server/drawing.functions";
import { useVault } from "@/app/vault/store";
import { bearerHeader } from "@/lib/auth/bearer";
import { findByTitle } from "@/domain/vault/links";
import { getLocale, t } from "@/app/i18n";

/**
 * Editable Excalidraw files autosave after changes and at least every two seconds during
 * continuous drawing. Flush pending work when closing or switching tabs. Saves create grouped
 * file versions. Read through readDrawing because saves replace and delete storage objects.
 * Lazy-load Excalidraw and locally hosted fonts. Element links accept note titles, wiki links
 * or IDs and open notes in Grafito.
 */

type Lib = typeof import("@excalidraw/excalidraw");
type Scene = {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

let loader: Promise<Lib> | null = null;

function loadExcalidraw(): Promise<Lib> {
  // Browser-only import: Excalidraw accesses window on load. import.meta.env.SSR removes it from server builds.
  if (import.meta.env.SSR) return Promise.reject(new Error("Excalidraw solo en el navegador"));
  loader ??= (async () => {
    (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
      `${window.location.origin}/excalidraw/`;
    await import("@excalidraw/excalidraw/index.css");
    return import("@excalidraw/excalidraw");
  })();
  return loader;
}

/** Debounce delay after a drawing change. */
const SAVE_DELAY_MS = 600;
/** Maximum delay while drawing continuously. */
const SAVE_MAX_WAIT_MS = 2000;

/** Keepalive payload budget below the browser's 64 KB limit. */
const KEEPALIVE_MAX = 60_000;

/** Determine dark mode from background luminance. */
function darkTheme(): boolean {
  const color = getComputedStyle(document.body).backgroundColor;
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  const [r = 255, g = 255, b = 255] = parts;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * Only element versions, images and canvas color change persisted drawing content. Panning and
 * zooming do not trigger saves.
 */
function sceneKey(
  lib: Lib,
  elements: readonly unknown[],
  appState: Record<string, unknown>,
  files: Record<string, unknown>,
): string {
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
        savedKey.current = sceneKey(
          loaded,
          restored.elements,
          restored.appState as never,
          restored.files as never,
        );
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

  /** Flush pending changes and save again if changes arrive during the request. */
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
        const result = await saveDrawing({
          data: { docId, content: next.content, ...(shareId ? { shareId } : {}) },
        });
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
      // Another change arrived just as saving completed.
      if (pending.current)
        timer.current = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Flush immediately when closing, switching tabs or leaving the page.
  useEffect(() => {
    const now = () => void flushRef.current();
    const onHidden = () => {
      if (document.visibilityState === "hidden") now();
    };
    // Normal requests are canceled on unload; send pending drawing content through keepalive POST /api/drawings/:id.
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
    const key = link
      .replace(/^\[\[|\]\]$/g, "")
      .replace(/^https?:\/\//, "")
      .trim();
    const documents = useVault.getState().documents;
    const target = documents.find((item) => item.id === key) ?? findByTitle(documents, key);
    return target?.id ?? null;
  };

  return (
    <div
      data-ui="drawing"
      className="relative h-full min-h-[60vh] overflow-hidden rounded-md border border-line"
    >
      <Excalidraw
        initialData={scene}
        viewModeEnabled={!canEdit}
        theme={darkTheme() ? "dark" : "light"}
        langCode={getLocale() === "en" ? "en" : "es-ES"}
        UIOptions={UI_OPTIONS}
        onChange={(
          elements: readonly unknown[],
          appState: Record<string, unknown>,
          files: Record<string, unknown>,
        ) => {
          if (!canEdit) return;
          const key = sceneKey(lib, elements, appState, files);
          if (key === savedKey.current && !pending.current) return;
          pending.current = {
            key,
            content: lib.serializeAsJSON(
              elements as never,
              appState as never,
              files as never,
              "local",
            ),
          };
          const started = waitingSince.current || Date.now();
          waitingSince.current = started;
          window.clearTimeout(timer.current);
          const late = Date.now() - started >= SAVE_MAX_WAIT_MS;
          timer.current = window.setTimeout(
            () => void flushRef.current(),
            late ? 0 : SAVE_DELAY_MS,
          );
        }}
        onLinkOpen={(
          element: { link?: string | null },
          event: CustomEvent<{ nativeEvent: Event }>,
        ) => {
          const target = element.link ? openLink(element.link) : null;
          if (!target || !onOpenNote) return;
          event.preventDefault();
          void flushRef.current();
          onOpenNote(target);
        }}
      >
        {/* Grafito drawing menu excludes external Excalidraw links and standalone file open/save actions. */}
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
          {status === "saving"
            ? t("Guardando…")
            : status === "saved"
              ? t("Guardado")
              : error || t("No se pudo guardar.")}
        </span>
      ) : null}
    </div>
  );
}

/** Keep the object outside the component for stable identity. */
const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false },
};
