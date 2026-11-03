/**
 * Security headers applied by src/start.ts. CSP currently allows inline scripts/styles for
 * TanStack SSR state and theme bootstrap; nonce migration is tracked in ROADMAP.md. External
 * images support note URLs, PDFs use data-URL frames, and the configured Office origin accepts
 * frames and opening forms.
 */
export function securityHeaders(
  dev: boolean,
  officeOrigin: string | null = null,
): Record<string, string> {
  const office = officeOrigin ? ` ${officeOrigin}` : "";
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "media-src 'self' data: blob:",
    `frame-src 'self' data: blob:${office}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${office}`,
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
