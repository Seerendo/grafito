import { useEffect } from "react";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { onSessionUserChange, writeSessionUser } from "@/lib/auth/session-sync";

/**
 * Mantiene esta pestaña con la misma sesión que las demás del navegador (ver
 * `lib/auth/session-sync.ts`): anota quién entró aquí y sigue lo que pase en
 * las otras pestañas.
 */
export function SessionSync() {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id ?? "";

  // Quien tiene la sesión en esta pestaña (al entrar por cualquier vía).
  useEffect(() => {
    if (isPending || !userId) return;
    writeSessionUser(userId);
  }, [isPending, userId]);

  useEffect(
    () =>
      onSessionUserChange((next) => {
        if (next === userId) return;
        // Salió en otra pestaña: al ingreso. Entró otra persona (o entró
        // mientras aquí no había sesión): se recarga con esa sesión.
        if (!next) window.location.replace("/");
        else window.location.reload();
      }),
    [userId],
  );

  return null;
}
