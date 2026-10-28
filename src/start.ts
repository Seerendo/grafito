import { createMiddleware, createStart } from "@tanstack/react-start";
import { securityHeaders } from "@/lib/security-headers";
import { editorOrigin, isSameOrigin } from "@/server/office-reach";

/**
 * Origen del editor de Office para esta página (ver `server/office-reach.ts`):
 * si `COLLABORA_URL` quedó en 127.0.0.1 y se entra por la dirección del
 * servidor, el editor está en esa dirección.
 */
function officeOrigin(requestUrl: string): string | null {
  const url = process.env.COLLABORA_URL?.trim();
  // En la misma dirección que Grafito ya lo cubre 'self'.
  if (!url || isSameOrigin(url)) return null;
  try {
    return editorOrigin(url, new URL(requestUrl).origin);
  } catch {
    return null;
  }
}

/**
 * Middleware global de peticiones: antes de nada, los secretos propios de la
 * instalación si faltan o son los de ejemplo (`server/install-secrets.ts`);
 * después, cabeceras de seguridad en cada respuesta.
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
