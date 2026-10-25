import { useEffect } from "react";
import { startVaultSync } from "@/app/vault/sync";
import { useVault } from "@/app/vault/store";
import { useCurrentUser } from "@/lib/auth/use-current-user";

/** Mantiene la bóveda abierta sincronizada con el servidor (ver `app/vault/sync.ts`). */
export function VaultSync() {
  const userId = useCurrentUser()?.id;
  const owner = useVault((state) => state.owner);

  useEffect(() => {
    if (!userId || owner !== userId) return;
    return startVaultSync(userId);
  }, [userId, owner]);

  return null;
}
