/**
 * Límite de envíos de los formularios públicos (sin sesión): por dirección y
 * por formulario, en una ventana de un minuto. Sin él, quien tenga el enlace
 * podría llenar la tabla o subir archivos sin parar. Vive en memoria de cada
 * instancia; con varias, el límite efectivo se multiplica por ellas, que sigue
 * cortando un abuso. Sin `@/` en los imports: se prueba con `node --test`.
 */

const WINDOW_MS = 60_000;

export const LIMITS = {
  /** Envíos de una misma dirección a un formulario. */
  submitPerAddress: 5,
  /** Envíos a un formulario entre todos. */
  submitPerForm: 60,
  /** Archivos subidos por una misma dirección a un formulario. */
  filePerAddress: 10,
} as const;

const hits = new Map<string, number[]>();

function take(key: string, max: number, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // Que el mapa no crezca sin fin con direcciones que ya no vuelven.
  if (hits.size > 20_000) {
    for (const [other, times] of hits) if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(other);
  }
  return true;
}

/** Si se admite un envío (`submit`) o un archivo (`file`) más; `false` si hay que esperar. */
export function allowPublicForm(kind: "submit" | "file", token: string, address: string, now = Date.now()): boolean {
  if (kind === "file") return take(`file:${token}:${address}`, LIMITS.filePerAddress, now);
  if (!take(`form:${token}`, LIMITS.submitPerForm, now)) return false;
  return take(`submit:${token}:${address}`, LIMITS.submitPerAddress, now);
}

/**
 * La dirección de quien envía: la última de `X-Forwarded-For`, que es la que
 * añade el gateway de Grafito (las anteriores las puede inventar el cliente).
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").map((part) => part.trim()).filter(Boolean).pop();
  return last || headers.get("x-real-ip") || "desconocida";
}

/** Solo para pruebas. */
export function resetFormLimits(): void {
  hits.clear();
}
