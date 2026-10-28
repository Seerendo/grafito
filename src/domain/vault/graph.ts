import { extractWikiLinks, findByTitle } from "./links.ts";
import type { Document, GraphEdge } from "./types.ts";

/**
 * Un nodo del grafo: una nota o archivo, o también un portafolio vinculado o
 * algo compartido conmigo (`shared`) al que apunta un vínculo.
 */
export type GraphNode = Pick<Document, "id" | "title" | "content" | "links" | "pinned"> & {
  kind: "markdown" | "file" | "portfolio";
  shared?: boolean;
};

export function graphEdges(documents: GraphNode[]): GraphEdge[] {
  // Los [[enlaces]] solo van a notas y archivos propios.
  const own = documents.filter((item): item is Document => item.kind !== "portfolio" && !item.shared);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: GraphEdge["kind"]) => {
    if (!from || !to || from === to) return;
    const key = `${kind}|${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  for (const document of documents) {
    if (document.kind === "markdown") {
      for (const title of extractWikiLinks(document.content)) {
        const target = findByTitle(own, title);
        if (target) add(document.id, target.id, "wiki");
      }
    }
    for (const link of document.links) {
      if (documents.some((item) => item.id === link.targetId)) {
        add(document.id, link.targetId, link.kind);
      }
    }
  }
  return edges;
}

export function graphClickIntent(
  previous: { id: string; at: number } | null,
  id: string,
  at: number,
  moved: boolean,
  windowMs = 450,
): "drag" | "inspect" | "open" {
  if (moved) return "drag";
  if (previous && previous.id === id && at - previous.at <= windowMs && at >= previous.at) return "open";
  return "inspect";
}
