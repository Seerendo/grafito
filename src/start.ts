import { createMiddleware, createStart } from "@tanstack/react-start";
import { securityHeaders } from "@/lib/security-headers";

/** Middleware global de peticiones: cabeceras de seguridad en cada respuesta. */
const withSecurityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next();
  const headers = securityHeaders(process.env.NODE_ENV !== "production");
  for (const [name, value] of Object.entries(headers)) {
    if (!result.response.headers.has(name)) result.response.headers.set(name, value);
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [withSecurityHeaders],
}));
