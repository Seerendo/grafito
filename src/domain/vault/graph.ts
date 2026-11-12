import type { Document } from "./types.ts";

/** Graph node representing a document, linked portfolio or referenced shared target. */
export type GraphNode = Pick<Document, "id" | "title" | "content" | "links" | "pinned"> & {
  kind: "markdown" | "file" | "portfolio";
  shared?: boolean;
};

export function graphClickIntent(
  previous: { id: string; at: number } | null,
  id: string,
  at: number,
  moved: boolean,
  windowMs = 450,
): "drag" | "inspect" | "open" {
  if (moved) return "drag";
  if (previous && previous.id === id && at - previous.at <= windowMs && at >= previous.at)
    return "open";
  return "inspect";
}

type Link = { from: string; to: string };

/** Links as an undirected adjacency list: "related" ignores who links to whom. */
function adjacency(edges: readonly Link[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = out.get(a);
    if (list) list.push(b);
    else out.set(a, [b]);
  };
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    add(edge.from, edge.to);
    add(edge.to, edge.from);
  }
  return out;
}

/** The node and everything within depth links of it, in either direction. */
export function neighbourhood(edges: readonly Link[], start: string, depth: number): Set<string> {
  const near = adjacency(edges);
  const seen = new Set([start]);
  let frontier = [start];
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of near.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * The shortest chain of links from one node to another, in either direction, both ends
 * included; null when they are not connected. Breadth first, so every step counts the same.
 */
export function shortestPath(edges: readonly Link[], from: string, to: string): string[] | null {
  if (from === to) return [from];
  const near = adjacency(edges);
  const parent = new Map<string, string>([[from, from]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of near.get(id) ?? []) {
        if (parent.has(other)) continue;
        parent.set(other, id);
        if (other === to) {
          const path = [to];
          let at = to;
          while (at !== from) {
            at = parent.get(at)!;
            path.push(at);
          }
          return path.reverse();
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}
