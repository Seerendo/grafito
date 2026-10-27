/**
 * Una sola sesión por navegador, en todas sus pestañas.
 *
 * Cada pestaña con sesión anota en `localStorage` quién entró
 * (`grafito.session-user`). Al cambiar esa marca en otra pestaña (alguien
 * salió, o entró por cualquier vía: contraseña, LDAP, OAuth, SSO), el
 * navegador avisa al resto con el evento `storage`, y cada pestaña se pone
 * al día: sin sesión vuelve al ingreso; con otra persona, se recarga como
 * ella. Así no quedan pestañas con una sesión cerrada ni dos usuarios a la vez.
 */

const KEY = "grafito.session-user";

export function readSessionUser(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Anota quién tiene la sesión (`""` al salir). */
export function writeSessionUser(userId: string): void {
  try {
    if (window.localStorage.getItem(KEY) !== userId) window.localStorage.setItem(KEY, userId);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Avisa de un cambio de sesión hecho en otra pestaña. */
export function onSessionUserChange(listener: (userId: string) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener(event.newValue ?? "");
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
