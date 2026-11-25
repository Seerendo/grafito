import { useEffect } from "react";
import { usePermissions } from "@/app/permissions";
import { refreshPluginFlags, usePluginActive } from "@/app/plugins";
import { PERMISSION } from "@/domain/permissions";

/**
 * Whether this person has the mail module: their role has mailbox.use and the Correo extension is
 * on with its worker connected. It follows the extension flags the administration screen updates
 * when the extension is switched, and the vault refreshes every minute and on focus, so turning it
 * on or off shows without reloading the page.
 */
export function useMailAvailable(): boolean {
  const can = usePermissions();
  const active = usePluginActive("correo");
  useEffect(() => {
    void refreshPluginFlags();
    const onFocus = () => void refreshPluginFlags();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return active && can(PERMISSION.mailboxUse);
}
