import { Braces, KeyRound, SlidersHorizontal, Sparkles, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { setAccountProfile } from "@/app/account-profile";
import { usePermissions } from "@/app/permissions";
import { AppFrame } from "@/components/chrome/AppFrame";
import { SettingsNav, type SettingsItem } from "@/components/chrome/SettingsNav";
import { OptionGrid } from "@/components/ui/OptionGrid";
import { PERMISSION } from "@/domain/permissions";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { accountState } from "@/server/session.functions";
import { AiSettings } from "./AiSettings";
import { ApiTokens } from "./ApiTokens";
import { PasswordForm } from "./PasswordForm";
import { PreferencesForm } from "./PreferencesForm";
import { ProfileForm } from "./ProfileForm";
import { t } from "@/app/i18n";

/**
 * Cuenta: por secciones, con la misma estructura que Administración (barra
 * plegable en escritorio, tarjetas y «Atrás» en móvil).
 */

type Section = "perfil" | "preferencias" | "contrasena" | "ia" | "api";

type Profile = Awaited<ReturnType<typeof accountState>>;

const SECTIONS: SettingsItem<Section>[] = [
  { id: "perfil", label: "Datos de la cuenta", icon: UserRound },
  { id: "preferencias", label: "Preferencias de usuario", icon: SlidersHorizontal },
  { id: "contrasena", label: "Contraseña", icon: KeyRound },
  { id: "ia", label: "Conexiones de IA", icon: Sparkles },
  { id: "api", label: "API", icon: Braces },
];

export function AccountScreen() {
  const { user, isPending } = useCurrentUserState();
  const can = usePermissions();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    void accountState()
      .then((next) => {
        if (cancelled) return;
        setProfile(next);
        setAccountProfile({
          userId: user.id,
          displayName: next.displayName,
          contactEmail: next.contactEmail,
          loginName: next.loginName,
          isAdmin: next.isAdmin,
          canAdmin: next.canAdmin,
        });
      })
      .catch(() => {
        if (!cancelled) setError(t("No se pudo leer la cuenta."));
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (isPending || (user && !profile && !error)) {
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center text-sm text-muted">{t("Cargando…")}</p>
      </AppFrame>
    );
  }
  if (!user) return <RedirectToSignIn />;
  if (error || !profile) {
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center text-sm text-danger">{t(error)}</p>
      </AppFrame>
    );
  }
  if (profile.mustChangePassword) return <Navigate to="/" />;

  const items = SECTIONS.filter(
    (item) => (item.id !== "ia" || can(PERMISSION.aiUse)) && (item.id !== "api" || can(PERMISSION.apiUse)),
  );
  const current = items.find((item) => item.id === section) ?? null;

  return (
    <AppFrame>
      <div data-ui="panes" className="flex min-h-0 flex-1">
        <SettingsNav
          title={t("Cuenta")}
          storageKey="grafito.account-nav"
          allLabel={t("Todas")}
          items={items}
          active={current?.id ?? null}
          onSelect={setSection}
          footer={profile.loginName}
        />
        <div data-ui="workspace" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="grafito-in w-full px-4 py-6 sm:px-8">
            {current ? (
              <button type="button" onClick={() => setSection(null)} className="mb-3 text-sm text-accent md:hidden">
                {t("Atrás")}
              </button>
            ) : null}
            <h1 className="font-serif text-3xl tracking-tight">{current ? t(current.label) : t("Cuenta")}</h1>
            <div className="mt-6">
              {!current ? <OptionGrid items={items} onPick={setSection} /> : null}
              {current?.id === "perfil" ? (
                <ProfileForm
                  userId={user.id}
                  initial={{ name: profile.displayName, email: profile.contactEmail }}
                  identity={{ loginName: profile.loginName, isAdmin: profile.isAdmin, canAdmin: profile.canAdmin }}
                />
              ) : null}
              {current?.id === "preferencias" ? <PreferencesForm /> : null}
              {current?.id === "contrasena" ? <PasswordForm loginEmail={profile.email} /> : null}
              {current?.id === "ia" ? <AiSettings /> : null}
              {current?.id === "api" ? <ApiTokens /> : null}
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
