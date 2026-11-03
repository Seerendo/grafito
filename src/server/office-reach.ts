/**
 * Office reachability diagnostics. same-origin uses the gateway. Loopback editor URLs are
 * rewritten to the browser's Grafito hostname at the Collabora port. officeProblem explains
 * browser blocking with the required setting. See docs/OFFICE.md.
 */

/** COLLABORA_URL value for same-origin editor hosting. */
export const SAME_ORIGIN = "same-origin";

export function isSameOrigin(configured: string): boolean {
  return configured.trim().toLowerCase() === SAME_ORIGIN;
}

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1)$/i;

function isLoopback(hostname: string): boolean {
  return LOOPBACK.test(hostname);
}

/** Editor origin for the given page origin. */
export function editorOrigin(configured: string, pageOrigin?: string | null): string {
  if (isSameOrigin(configured)) {
    if (!pageOrigin) throw new Error("Falta la dirección de la página.");
    return new URL(pageOrigin).origin;
  }
  const editor = new URL(configured);
  if (pageOrigin) {
    const page = new URL(pageOrigin);
    if (isLoopback(editor.hostname) && !isLoopback(page.hostname)) editor.hostname = page.hostname;
  }
  return editor.origin;
}

/**
 * Check Collabora frame-ancestors against pageOrigin, supporting space-separated hosts,
 * schemes, ports and wildcards. Collabora always allows 127.0.0.1.
 */
export function ancestorsAllow(list: string, pageOrigin: string): boolean {
  const page = new URL(pageOrigin);
  if (/^127\./.test(page.hostname)) return true;
  const defaultPort = page.protocol === "https:" ? "443" : "80";
  const pagePort = page.port || defaultPort;
  return list
    .split(/\s+/)
    .filter(Boolean)
    .some((raw) => {
      if (raw === "*") return true;
      const match = /^(?:(https?):\/\/)?([^/:]+)(?::(\*|\d+))?\/?$/i.exec(raw);
      if (!match) return false;
      const [, scheme, host = "", port] = match;
      if (scheme && `${scheme.toLowerCase()}:` !== page.protocol) return false;
      const hostOk = host.startsWith("*.")
        ? page.hostname.toLowerCase().endsWith(host.slice(1).toLowerCase())
        : host.toLowerCase() === page.hostname.toLowerCase();
      if (!hostOk) return false;
      if (port === "*") return true;
      return (
        (port ?? (scheme === "https" ? "443" : scheme === "http" ? "80" : defaultPort)) === pagePort
      );
    });
}

/** Reason the editor cannot load from pageOrigin, or null. */
export function officeProblem(input: {
  collaboraUrl: string;
  pageOrigin: string;
  frameAncestors: string;
  sslTermination: boolean;
}): string | null {
  if (isSameOrigin(input.collaboraUrl)) return null;
  const page = new URL(input.pageOrigin);
  const editor = new URL(editorOrigin(input.collaboraUrl, input.pageOrigin));
  if (page.protocol === "https:" && editor.protocol === "http:") {
    return `Grafito se abre por HTTPS y el editor de Office por HTTP (${editor.origin}); el navegador lo bloquea. Publica Collabora por HTTPS (COLLABORA_URL=https://…) detrás de tu proxy y pon COLLABORA_SSL_TERMINATION=true.`;
  }
  if (editor.protocol === "https:" && !input.sslTermination) {
    return "El editor de Office se publica por HTTPS, pero Collabora no lo sabe y abriría conexiones inseguras (ws://). Pon COLLABORA_SSL_TERMINATION=true y reinicia Collabora.";
  }
  if (!ancestorsAllow(input.frameAncestors, input.pageOrigin)) {
    const value = page.port ? `${page.hostname}:${page.port}` : page.hostname;
    return `El editor de Office no permite mostrarse en ${page.origin}. Pon GRAFITO_PUBLIC_ORIGIN=${value} en el .env y reinicia (docker compose up -d).`;
  }
  return null;
}
