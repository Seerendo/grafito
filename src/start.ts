import { createMiddleware, createStart } from "@tanstack/react-start";
import { securityHeaders } from "@/lib/security-headers";

/** Origen del editor de Office, si está configurado (ver `server/office.ts`). */
function officeOrigin(): string | null {
  const url = process.env.COLLABORA_URL?.trim();
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Middleware global de peticiones: cabeceras de seguridad en cada respuesta. */
const withSecurityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next();
  const headers = securityHeaders(process.env.NODE_ENV !== "production", officeOrigin());
  for (const [name, value] of Object.entries(headers)) {
    if (!result.response.headers.has(name)) result.response.headers.set(name, value);
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [withSecurityHeaders],
}));
