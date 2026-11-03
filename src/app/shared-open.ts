import { unpackTree, type PackedTree } from "@/domain/share-pack";
import { bearerHeader } from "@/lib/auth/bearer";
import type { SharedTree } from "@/server/share";

/**
 * Fetch and unpack shared or public trees; see domain/share-pack.ts. null means access was
 * lost. Both endpoints use ETags so unchanged trees return 304. fresh bypasses short-lived
 * cached content after mutations.
 */
export function fetchSharedTree(shareId: string, fresh = false): Promise<SharedTree | null> {
  return fetchTree(`/api/shared/${encodeURIComponent(shareId)}/tree`, fresh, bearerHeader());
}

export function fetchPublicTree(token: string): Promise<SharedTree | null> {
  return fetchTree(`/api/public/${encodeURIComponent(token)}/tree`, false, {});
}

async function fetchTree(
  path: string,
  fresh: boolean,
  headers: Record<string, string>,
): Promise<SharedTree | null> {
  const response = await fetch(`${path}${fresh ? "?fresh=1" : ""}`, {
    headers,
    credentials: "same-origin",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`No se pudo abrir lo compartido (${response.status}).`);
  const share = JSON.parse(
    decodeURIComponent(response.headers.get("x-grafito-share") ?? ""),
  ) as PackedTree["share"];
  return unpackTree({ share, body: await response.text() });
}
