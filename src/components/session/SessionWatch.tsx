import { useEffect } from "react";
import { clearAccountProfile } from "@/app/account-profile";
import { clearPermissions, setPermissions } from "@/app/permissions";
import { clearMyShares } from "@/app/shares";
import { clearHeldAdmin } from "@/app/vault-hold";
import { useVault } from "@/app/vault/store";
import { signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { sessionPulse } from "@/server/session.functions";

const GAP_MS = 4000;

function expired(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  return text.includes("unauthorized");
}

export function SessionWatch() {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id;

  useEffect(() => {
    if (isPending || !userId) return;
    let cancelled = false;
    let last = 0;
    let timer = 0;

    const drop = () => {
      if (cancelled) return;
      cancelled = true;
      useVault.getState().closeVault();
      clearPermissions();
      clearMyShares();
      clearHeldAdmin();
      clearAccountProfile();
      void signOut("/").catch(() => {
        window.location.replace("/");
      });
    };

    const beat = (force: boolean) => {
      if (cancelled || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (!force && now - last < GAP_MS) return;
      last = now;
      void sessionPulse()
        .then((result) => {
          if (!result.ok) drop();
          else setPermissions(result);
        })
        .catch((error: unknown) => {
          if (expired(error)) drop();
        });
    };

    const onShow = () => beat(true);
    const onAction = () => beat(false);
    beat(true);
    timer = window.setInterval(() => beat(true), 12000);
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pointerdown", onAction, { passive: true });
    window.addEventListener("keydown", onAction);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pointerdown", onAction);
      window.removeEventListener("keydown", onAction);
    };
  }, [isPending, userId]);

  return null;
}
