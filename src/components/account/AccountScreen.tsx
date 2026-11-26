import { Braces, Inbox, KeyRound, Mail, SlidersHorizontal, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { setAccountProfile } from "@/app/account-profile";
import { useMailAvailable } from "@/app/mail/available";
import { usePermissions } from "@/app/permissions";
import { AppFrame } from "@/components/chrome/AppFrame";
import { SettingsNav, type SettingsItem } from "@/components/chrome/SettingsNav";
import { OptionGrid } from "@/components/ui/OptionGrid";
import { PERMISSION } from "@/domain/permissions";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { accountState } from "@/server/session.functions";
import { ApiTokens } from "./ApiTokens";
import { PasswordForm } from "./PasswordForm";
import { PreferencesForm } from "./PreferencesForm";
import { MailAccounts } from "@/components/mail/MailAccounts";
import { MailForm } from "./MailForm";
import { ProfileForm } from "./ProfileForm";
import { t } from "@/app/i18n";

/**
 * Account sections use the administration layout: collapsible desktop navigation and mobile
 * cards with back navigation.
 */

type Section = "profile" | "email" | "mailboxes" | "preferences" | "password" | "api";

type Profile = Awaited<ReturnType<typeof accountState>>;

const SECTIONS: SettingsItem<Section>[] = [
  { id: "profile", label: "Datos de la cuenta", icon: UserRound },
  { id: "email", label: "Correo", icon: Mail },
  { id: "mailboxes", label: "Cuentas de correo", icon: Inbox },
  { id: "preferences", label: "Preferencias de usuario", icon: SlidersHorizontal },
  { id: "password", label: "Contraseña", icon: KeyRound },
  { id: "api", label: "API", icon: Braces },
];

export function AccountScreen() {
  const { user, isPending } = useCurrentUserState();
  const can = usePermissions();
  const mail = useMailAvailable();
  // The section lives in the address (/account?section=…): a reload or a shared link opens it.
  const asked = useSearch({ strict: false }) as { section?: string };
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const section = SECTIONS.some((item) => item.id === asked.section)
    ? (asked.section as Section)
    : null;
  const setSection = (next: Section | null) =>
    void navigate({ to: "/account", search: next ? { section: next } : {}, replace: false });

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
    (item) => (item.id !== "api" || can(PERMISSION.apiUse)) && (item.id !== "mailboxes" || mail),
  );
  const current = items.find((item) => item.id === section) ?? null;

  return (
    <AppFrame>
      <div data-ui="panes" className="flex min-h-0 flex-1">
        <SettingsNav
          title={t("Cuenta")}
          allLabel={t("Todas")}
          items={items}
          active={current?.id ?? null}
          onSelect={setSection}
          footer={profile.loginName}
        />
        {/* The floating panel clips its edges (overflow hidden); the content scrolls inside it. */}
        <div data-ui="workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div data-ui="account-content" className="min-h-0 flex-1 overflow-y-auto">
            <div className="grafito-in w-full px-4 py-6 sm:px-8">
              {current ? (
                <button
                  type="button"
                  onClick={() => setSection(null)}
                  className="mb-3 text-sm text-accent md:hidden"
                >
                  {t("Atrás")}
                </button>
              ) : null}
              <h1 className="font-serif text-3xl tracking-tight">
                {current ? t(current.label) : t("Cuenta")}
              </h1>
              <div className="mt-6">
                {!current ? <OptionGrid items={items} onPick={setSection} /> : null}
                {current?.id === "profile" ? (
                  <ProfileForm
                    userId={user.id}
                    initial={{ name: profile.displayName }}
                    identity={{
                      loginName: profile.loginName,
                      isAdmin: profile.isAdmin,
                      canAdmin: profile.canAdmin,
                    }}
                  />
                ) : null}
                {current?.id === "email" ? <MailForm /> : null}
                {current?.id === "mailboxes" ? <MailAccounts /> : null}
                {current?.id === "preferences" ? <PreferencesForm /> : null}
                {current?.id === "password" ? <PasswordForm loginEmail={profile.email} /> : null}
                {current?.id === "api" ? <ApiTokens /> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
