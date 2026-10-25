/**
 * Nombres de las cookies de sesión. Conservan el prefijo heredado de la
 * plantilla original: cambiarlo cerraría todas las sesiones abiertas.
 */
export const AUTH_COOKIE_PREFIX = "__Host-grok-auth";
export const SESSION_TOKEN_COOKIE = `${AUTH_COOKIE_PREFIX}.session_token`;
