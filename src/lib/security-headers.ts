/**
 * Cabeceras de seguridad de todas las respuestas (las pone `src/start.ts`).
 *
 * La CSP permite scripts y estilos en línea porque el SSR de TanStack Start
 * inyecta el estado inicial y el script de tema en el HTML; pasar a nonces
 * está en ROADMAP.md. Las imágenes externas se permiten para que las notas
 * puedan enlazar imágenes por URL; los PDF se ven en un iframe con data URL.
 */
export function securityHeaders(dev: boolean): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "media-src 'self' data: blob:",
    "frame-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
