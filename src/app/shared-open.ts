import { unpackTree, type PackedTree } from "@/domain/share-pack";
import { bearerHeader } from "@/lib/auth/bearer";
import type { SharedTree } from "@/server/share";

/**
 * Abrir algo compartido conmigo (`/api/shared/:id/tree`) o publicado por
 * enlace (`/api/public/:token/tree`): el árbol llega empaquetado (ver
 * `domain/share-pack.ts`) y aquí se desempaqueta. `null` si ya no se tiene
 * acceso. Las dos rutas mandan ETag: el navegador guarda la última versión y,
 * si no cambió, el servidor responde 304 sin volver a mandarla.
 *
 * `fresh`: tras crear o borrar algo, para verlo ya (si no, puede llegar el de
 * hace unos segundos).
 */
export function fetchSharedTree(shareId: string, fresh = false): Promise<SharedTree | null> {
  return fetchTree(`/api/shared/${encodeURIComponent(shareId)}/tree`, fresh, bearerHeader());
}

export function fetchPublicTree(token: string): Promise<SharedTree | null> {
  return fetchTree(`/api/public/${encodeURIComponent(token)}/tree`, false, {});
}

async function fetchTree(path: string, fresh: boolean, headers: Record<string, string>): Promise<SharedTree | null> {
  const response = await fetch(`${path}${fresh ? "?fresh=1" : ""}`, { headers, credentials: "same-origin" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`No se pudo abrir lo compartido (${response.status}).`);
  const share = JSON.parse(decodeURIComponent(response.headers.get("x-grafito-share") ?? "")) as PackedTree["share"];
  return unpackTree({ share, body: await response.text() });
}
