import { useSyncExternalStore } from "react";
import type { PermissionKey } from "@/domain/permissions";

/**
 * Client permissions loaded by AccessGate and refreshed by SessionWatch on each pulse. Role
 * changes apply without signing in again; permissions default to denied while loading. Server
 * functions enforce authorization independently.
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
    grants.all === next.isAdmin &&
    grants.keys.size === keys.size &&
    [...keys].every((key) => grants.keys.has(key));
  if (same) return;
  grants = { all: next.isAdmin, keys };
  emit();
}

export function clearPermissions(): void {
  if (grants === NONE) return;
  grants = NONE;
  emit();
}

/** One-time permission lookup outside React, such as stores. */
export function can(key: PermissionKey): boolean {
  return grants.all || grants.keys.has(key);
}

export function subscribePermissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Permission checker for components using several keys; rerenders on role changes. */
export function usePermissions(): (key: PermissionKey) => boolean {
  useSyncExternalStore(
    subscribePermissions,
    () => version,
    () => 0,
  );
  return can;
}

/** Whether the current user has this permission, updated when their role changes. */
export function useCan(key: PermissionKey): boolean {
  return useSyncExternalStore(
    subscribePermissions,
    () => can(key),
    () => false,
  );
}
