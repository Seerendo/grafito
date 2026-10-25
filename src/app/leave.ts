import { clearAccountProfile } from "@/app/account-profile";
import { clearPermissions } from "@/app/permissions";
import { clearMyShares } from "@/app/shares";
import { useSharedView } from "@/app/shared-view";
import { clearHeldAdmin } from "@/app/vault-hold";
import { useVault } from "@/app/vault/store";
import { signOut } from "@/lib/auth/client";
import { revokeOwnLease } from "@/server/session.functions";

export async function leaveApp(): Promise<void> {
  try {
    await revokeOwnLease();
  } catch {
    /* la sesión ya no estaba */
  }
  useVault.getState().closeVault();
  clearPermissions();
  clearMyShares();
  useSharedView.getState().closeShared();
  clearHeldAdmin();
  clearAccountProfile();
  try {
    await signOut("/");
  } catch {
    window.location.replace("/");
  }
}
