/**
 * Excalidraw JSON files behave like other vault files for links, sharing and versions.
 * DrawingView renders and edits them.
 */

export const DRAWING_MIME = "application/vnd.excalidraw+json";

export function isDrawingName(name: string): boolean {
  return /\.excalidraw$/i.test(name);
}

/** Empty drawing used for creation. */
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
