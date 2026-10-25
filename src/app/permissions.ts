import { useSyncExternalStore } from "react";
import type { PermissionKey } from "@/domain/permissions";

/**
 * Permisos del usuario con sesión, en el cliente. Los carga `AccessGate` al
 * entrar y los refresca `SessionWatch` con cada pulso, así que un cambio de rol
 * se aplica sin volver a entrar. Sin cargar, todo está denegado.
 *
 * Es la capa de interfaz: el servidor sigue comprobando sus propias funciones.
 */
type Grants = { all: boolean; keys: ReadonlySet<string> };

const NONE: Grants = { all: false, keys: new Set() };

let grants: Grants = NONE;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function setPermissions(next: { isAdmin: boolean; permissions: readonly string[] }): void {
  const keys = new Set(next.permissions);
  const same =
    grants.all === next.isAdmin && grants.keys.size === keys.size && [...keys].every((key) => grants.keys.has(key));
  if (same) return;
  grants = { all: next.isAdmin, keys };
  emit();
}

export function clearPermissions(): void {
  if (grants === NONE) return;
  grants = NONE;
  emit();
}

/** Lectura puntual, para código fuera de React (p. ej. el store). */
export function can(key: PermissionKey): boolean {
  return grants.all || grants.keys.has(key);
}

export function subscribePermissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `can` para componentes que comprueban varias claves; re-renderiza al cambiar el rol. */
export function usePermissions(): (key: PermissionKey) => boolean {
  useSyncExternalStore(
    subscribePermissions,
    () => version,
    () => 0,
  );
  return can;
}

/** `true` si el usuario actual tiene `key`; se actualiza al cambiar su rol. */
export function useCan(key: PermissionKey): boolean {
  return useSyncExternalStore(
    subscribePermissions,
    () => can(key),
    () => false,
  );
}
