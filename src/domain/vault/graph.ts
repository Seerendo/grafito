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
