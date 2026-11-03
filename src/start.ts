import { createMiddleware, createStart } from "@tanstack/react-start";
import { securityHeaders } from "@/lib/security-headers";
import { editorOrigin, isSameOrigin } from "@/server/office-reach";

/**
 * Resolve Office origin for the current page, replacing loopback with the server address where
 * appropriate; see office-reach.ts.
 */
function officeOrigin(requestUrl: string): string | null {
  const url = process.env.COLLABORA_URL?.trim();
  // Same-origin editor hosting is already covered by self.
  if (!url || isSameOrigin(url)) return null;
  try {
    return editorOrigin(url, new URL(requestUrl).origin);
  } catch {
    return null;
  }
}

/**
 * Global request middleware initializes installation secrets before applying security headers
 * to every response.
 */
const withSecurityHeaders = createMiddleware().server(async ({ next, request }) => {
  const { ensureInstallSecrets } = await import("@/server/install-secrets");
  ensureInstallSecrets();
  const result = await next();
  const headers = securityHeaders(process.env.NODE_ENV !== "production", officeOrigin(request.url));
  for (const [name, value] of Object.entries(headers)) {
    if (!result.response.headers.has(name)) result.response.headers.set(name, value);
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [withSecurityHeaders],
}));
