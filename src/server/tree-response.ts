/**
 * Shared/public tree HTTP response: return 304 for matching versions, otherwise optionally
 * compressed content. x-grafito-share carries caller-specific access/token metadata.
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
  if (request.headers.get("if-none-match") === tree.etag)
    return new Response(null, { status: 304, headers });
  if (/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) {
    return new Response(new Uint8Array(tree.gzip()), {
      headers: { ...headers, "content-encoding": "gzip" },
    });
  }
  return new Response(tree.body(), { headers });
}
