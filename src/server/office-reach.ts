/**
 * Cómo llega el navegador al editor de Office (Collabora) y por qué podría no
 * llegar (solo servidor; sin `@/` en los imports: se prueba con `node --test`).
 * Ver docs/OFFICE.md, «Servidores y HTTPS».
 *
 * - `COLLABORA_URL=same-origin` (lo de fábrica con Docker): la puerta de
 *   entrada (`docker/gateway.conf`) sirve el editor en la misma dirección que
 *   Grafito, así que no hay nada que pueda fallar aquí.
 * - `editorOrigin`: si `COLLABORA_URL` quedó en 127.0.0.1/localhost y Grafito
 *   se abre desde otra dirección, el editor se pide a esa misma dirección, en
 *   el puerto de Collabora: 127.0.0.1 sería el equipo de quien navega.
 * - `officeProblem`: lo que el navegador va a bloquear, con el ajuste exacto
 *   que lo arregla, en vez de un editor en blanco.
 */

/** Valor de `COLLABORA_URL` para el editor servido en la dirección de Grafito. */
export const SAME_ORIGIN = "same-origin";

export function isSameOrigin(configured: string): boolean {
  return configured.trim().toLowerCase() === SAME_ORIGIN;
}

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1)$/i;

function isLoopback(hostname: string): boolean {
  return LOOPBACK.test(hostname);
}

/** Origen del editor para una página abierta en `pageOrigin`. */
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
 * Si una lista de `frame-ancestors` (la de Collabora: `GRAFITO_PUBLIC_ORIGIN`)
 * deja insertar el editor en `pageOrigin`. Entradas separadas por espacios:
 * `localhost:*`, `notas.ejemplo.com`, `https://notas.ejemplo.com:8443`,
 * `*.ejemplo.com`. 127.0.0.1 siempre vale (Collabora lo permite).
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
      return (port ?? (scheme === "https" ? "443" : scheme === "http" ? "80" : defaultPort)) === pagePort;
    });
}

/** Lo que impedirá ver el editor desde `pageOrigin`, o `null` si nada. */
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
