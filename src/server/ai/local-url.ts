/**
 * Validate self-hosted Ollama/LM Studio URLs, rejecting the app and internal deployment
 * services. In Docker, localhostAlias maps user localhost URLs to the host machine. Preserve
 * the user's url while requests use target. Relative imports support Node tests.
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
]);

function loopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "0.0.0.0" ||
    name === "::" ||
    name === "::1" ||
    /^127\./.test(name) ||
    /^::ffff:127\./.test(name)
  );
}

export type LocalUrlCheck =
  { ok: true; url: string; target: string } | { ok: false; error: string };

export function checkLocalUrl(raw: string, localhostAlias?: string | null): LocalUrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Escribe la dirección de tu instancia." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "La dirección no es válida (ej.: http://192.168.1.20:11434)." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "La dirección debe empezar por http:// o https://." };
  }
  if (url.username || url.password)
    return { ok: false, error: "No pongas usuario ni contraseña en la dirección." };
  const host = url.hostname.toLowerCase();
  const alias = localhostAlias?.trim().toLowerCase();
  if (loopback(host) && alias && !loopback(alias) && !INTERNAL_HOSTS.has(alias)) {
    url.hash = "";
    url.search = "";
    const typed = url.toString().replace(/\/+$/, "");
    url.hostname = alias;
    return { ok: true, url: typed, target: url.toString().replace(/\/+$/, "") };
  }
  if (loopback(host)) {
    return {
      ok: false,
      error:
        "«localhost» sería el propio servidor de Grafito. Usa la IP o el nombre de tu equipo (con Docker en tu máquina: host.docker.internal).",
    };
  }
  if (INTERNAL_HOSTS.has(host))
    return { ok: false, error: "Esa dirección es un servicio interno de Grafito." };
  url.hash = "";
  url.search = "";
  const clean = url.toString().replace(/\/+$/, "");
  return { ok: true, url: clean, target: clean };
}

/** Configured localhost alias. */
export function localhostAlias(): string | null {
  const value = typeof process === "undefined" ? undefined : process.env.GRAFITO_LOCALHOST_ALIAS;
  return value?.trim() || null;
}
