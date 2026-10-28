/**
 * Dibujos de Excalidraw: un archivo `.excalidraw` (JSON) como cualquier otro,
 * así que se vinculan, comparten y guardan versiones igual. Se dibujan y
 * editan en `components/vault/DrawingView.tsx`.
 */

export const DRAWING_MIME = "application/vnd.excalidraw+json";

export function isDrawingName(name: string): boolean {
  return /\.excalidraw$/i.test(name);
}

/** Un dibujo vacío, para «Nuevo dibujo». */
export function emptyDrawing(): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "grafito",
    elements: [],
    appState: { gridSize: 20, viewBackgroundColor: "#ffffff" },
    files: {},
  });
}
