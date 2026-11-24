/**
 * Addresses the server must not call on someone's behalf (SSO and LDAP providers): the app's own
 * deployment services and link-local addresses. Relative imports support Node tests.
 */

/** Compose service names and the application container hostname. */
const INTERNAL_HOSTS = new Set([
  "postgres",
  "redis",
  "elasticsearch",
  "minio",
  "minio-init",
  "app",
  "keycloak",
  "openldap",
  "grafeno",
  "collabora",
  "clamav",
  "latex",
  "gateway",
  "backup",
  "backup-files",
  "mailpit",
]);

/** Link-local addresses, cloud metadata (169.254.169.254) among them. */
function linkLocal(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    /^169\.254\./.test(name) ||
    /^::ffff:169\.254\./.test(name) ||
    /^::ffff:a9fe:[0-9a-f]{1,4}$/.test(name) ||
    /^fe[89ab][0-9a-f]:/.test(name)
  );
}

/**
 * Why the server must not call this host on an administrator's or a person's behalf: one of
 * Grafito's own services or a link-local address. LAN addresses stay allowed (security findings
 * GRAF-15 and GRAF-17). Null when it may be called.
 */
export function internalHostReason(host: string, allowed: string[] = []): string | null {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (INTERNAL_HOSTS.has(name) && !allowed.includes(name))
    return "Esa dirección es un servicio interno de Grafito.";
  if (linkLocal(name)) return "Esa dirección es de enlace local; no se puede usar.";
  return null;
}
