/**
 * Validación de la dirección de una instancia propia de Ollama o LM Studio.
 * El servidor de Grafito es quien llama a esa dirección, así que no se acepta
 * nada que apunte a él mismo ni a los servicios internos del despliegue
 * (base de datos, caché, índice, almacenamiento). Sin imports con alias: se
 * prueba con `node --test`.
 */

/** Nombres de los servicios de `docker-compose.yml` y del propio contenedor. */
const INTERNAL_HOSTS = new Set(["postgres", "redis", "elasticsearch", "minio", "minio-init", "app", "keycloak", "openldap"]);

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

export type LocalUrlCheck = { ok: true; url: string } | { ok: false; error: string };

export function checkLocalUrl(raw: string): LocalUrlCheck {
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
  if (url.username || url.password) return { ok: false, error: "No pongas usuario ni contraseña en la dirección." };
  const host = url.hostname.toLowerCase();
  if (loopback(host)) {
    return {
      ok: false,
      error:
        "«localhost» sería el propio servidor de Grafito. Usa la IP o el nombre de tu equipo (con Docker en tu máquina: host.docker.internal).",
    };
  }
  if (INTERNAL_HOSTS.has(host)) return { ok: false, error: "Esa dirección es un servicio interno de Grafito." };
  url.hash = "";
  url.search = "";
  return { ok: true, url: url.toString().replace(/\/+$/, "") };
}
