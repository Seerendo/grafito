const KEY = "grafito.unlocked";

export function heldAdminId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberAdmin(userId: string): void {
  try {
    sessionStorage.setItem(KEY, userId);
  } catch {
    /* private mode */
  }
}

export function clearHeldAdmin(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}
