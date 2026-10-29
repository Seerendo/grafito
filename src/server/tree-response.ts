/**
 * Respuesta de las rutas del árbol de lo compartido (`/api/shared/:id/tree` y
 * `/api/public/:token/tree`): 304 si el navegador ya tiene esa versión, y si
 * no el cuerpo, comprimido si lo acepta. Lo de cada persona (su nivel de
 * acceso, o el token del enlace) va en la cabecera `x-grafito-share`.
 */
export function treeHttpResponse(
  request: Request,
  tree: { share: unknown; body: () => string; etag: string; gzip: () => Buffer },
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-cache",
    etag: tree.etag,
    vary: "Accept-Encoding, Authorization, Cookie",
    "x-grafito-share": encodeURIComponent(JSON.stringify(tree.share)),
    "x-content-type-options": "nosniff",
  };
  if (request.headers.get("if-none-match") === tree.etag) return new Response(null, { status: 304, headers });
  if (/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) {
    return new Response(new Uint8Array(tree.gzip()), { headers: { ...headers, "content-encoding": "gzip" } });
  }
  return new Response(tree.body(), { headers });
}
