import { unpackTree, type PackedTree } from "@/domain/share-pack";
import { bearerHeader } from "@/lib/auth/bearer";
import type { SharedTree } from "@/server/share";
import { openPublic } from "@/server/share.functions";

/**
 * Abrir algo compartido conmigo (o por enlace público): el árbol llega
 * empaquetado (ver `domain/share-pack.ts`) y aquí se desempaqueta. `null` si ya
 * no se tiene acceso.
 *
 * Lo compartido conmigo se pide a `GET /api/shared/:id/tree`, que manda ETag:
 * el navegador guarda la última versión y, si no cambió, el servidor responde
 * 304 sin volver a mandarla.
 */
export async function fetchSharedTree(shareId: string, fresh = false): Promise<SharedTree | null> {
  // `fresh`: tras crear o borrar algo, para verlo ya (si no, puede llegar el de hace unos segundos).
  const response = await fetch(`/api/shared/${encodeURIComponent(shareId)}/tree${fresh ? "?fresh=1" : ""}`, {
    headers: bearerHeader(),
    credentials: "same-origin",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`No se pudo abrir lo compartido (${response.status}).`);
  const share = JSON.parse(decodeURIComponent(response.headers.get("x-grafito-share") ?? "")) as PackedTree["share"];
  return unpackTree({ share, body: await response.text() });
}

export async function fetchPublicTree(token: string): Promise<SharedTree | null> {
  const packed = await openPublic({ data: { token } });
  return packed ? unpackTree(packed) : null;
}
