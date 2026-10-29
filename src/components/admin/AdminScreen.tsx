import { Activity, Building2, ChevronRight, FolderOpen, PieChart, Clock, LayoutTemplate, Mail, Network, ShieldCheck, Sparkles, Database, HardDrive, KeyRound, Palette, Puzzle, ScrollText, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { setAccountProfile } from "@/app/account-profile";
import { readReloadState, useSaveOnReload } from "@/app/reload-state";
import { leaveApp } from "@/app/leave";
import { SESSION_PRESETS } from "@/domain/session";
import { setPluginFlags } from "@/app/plugins";
import { applyTheme, currentTheme, THEMES, type ThemeId } from "@/app/theme";
import { useVault } from "@/app/vault/store";
import { AppFrame } from "@/components/chrome/AppFrame";
import { Switch } from "@/components/ui/Switch";
import { UsageMeter } from "@/components/ui/UsageMeter";
import { OptionGrid } from "@/components/ui/OptionGrid";
import { SettingsNav } from "@/components/chrome/SettingsNav";
import { useAutoContextMenu } from "@/components/ui/use-auto-context-menu";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { adminState, probeSources, setPluginEnabled, setSourceEnabled } from "@/server/admin.functions";
import { setSessionTtl, storageReport } from "@/server/session.functions";
import { LogsBoard, MonitorBoard, RolesBoard, UsersBoard, type AdminView } from "./Boards";
import { OrgsBoard } from "./OrgsBoard";
import { QuotaBoard } from "./QuotaBoard";
import { WorkspaceBoard } from "./WorkspaceBoard";
import { AssignedSpaceBoard } from "./AssignedSpaceBoard";
import { DesignPanel } from "./DesignPanel";
import { AiBoard } from "./AiBoard";
import { MailBoard } from "./MailBoard";
import { LdapPanel, OAuthPanel, SsoPanel } from "./AuthBoards";
import { t } from "@/app/i18n";

type Section = "usuarios" | "autenticacion" | "ia" | "correo" | "plugins" | "apariencia" | "sesion" | "monitor";
type Leaf = "usuarios" | "roles" | "organizaciones" | "cuotas" | "cuotas-portafolio" | "espacios-trabajo" | "asignado" | "ldap" | "oauth" | "sso" | "monitor" | "logs" | "espacio" | "fuentes" | "temas" | "diseno";
type State = Awaited<ReturnType<typeof adminState>>;
type StoreSpace = {
  id: string;
  label: string;
  total: number | null;
  available: number | null;
  used: number | null;
};

const NAV: { id: Section; label: string; icon: typeof Users; need?: string[] }[] = [
  {
    id: "usuarios",
    label: "Usuarios y permisos",
    icon: Users,
    need: ["admin.access", "users.create", "users.update", "users.delete", "roles.manage", "orgs.manage", "space.manage"],
  },
  {
    id: "autenticacion",
    label: "Autenticación",
    icon: ShieldCheck,
    need: ["auth.manage"],
  },
  {
    id: "ia",
    label: "Inteligencia artificial",
    icon: Sparkles,
    need: ["ai.manage"],
  },
  { id: "correo", label: "Correo electrónico", icon: Mail, need: ["mail.manage"] },
  { id: "plugins", label: "Plugins", icon: Puzzle, need: ["plugins.manage"] },
  { id: "apariencia", label: "Apariencia", icon: Palette },
  { id: "sesion", label: "Sesión", icon: Clock, need: ["session.manage"] },
  {
    id: "monitor",
    label: "Monitorización y logs",
    icon: Activity,
    need: ["monitor.view", "admin.access", "sources.manage", "space.manage"],
  },
];

const NAV_KEY = "grafito.admin.nav";

function readNav(): { section: Section | null; leaf: Leaf | null; roleId: string | null } {
  try {
    const data = readReloadState<{ section?: unknown; leaf?: unknown; roleId?: unknown }>(NAV_KEY) ?? {};
    const section = NAV.some((item) => item.id === data.section) ? (data.section as Section) : null;
    return {
      section,
      leaf: section && typeof data.leaf === "string" ? (data.leaf as Leaf) : null,
      roleId: section && typeof data.roleId === "string" ? data.roleId : null,
    };
  } catch {
    return { section: null, leaf: null, roleId: null };
  }
}

/**
 * Los subapartados de cada sección (los mismos en sus tarjetas y en la barra
 * lateral), según los permisos del rol.
 */
function leavesOf(view: AdminView, section: Section): { id: Leaf; label: string; icon: typeof Users }[] {
  if (section === "usuarios") {
    return [
      ...(allowed(view, "users.create") || allowed(view, "users.update") || allowed(view, "users.delete")
        ? [{ id: "usuarios" as const, label: "Usuarios", icon: Users }]
        : []),
      ...(allowed(view, "roles.manage") ? [{ id: "roles" as const, label: "Roles", icon: KeyRound }] : []),
      ...(allowed(view, "orgs.manage") ? [{ id: "organizaciones" as const, label: "Organizaciones", icon: Building2 }] : []),
      ...(allowed(view, "space.manage")
        ? [
            { id: "cuotas" as const, label: "Espacio por usuario", icon: HardDrive },
            { id: "cuotas-portafolio" as const, label: "Espacio por portafolio", icon: FolderOpen },
            { id: "espacios-trabajo" as const, label: "Espacios de trabajo", icon: Building2 },
          ]
        : []),
    ];
  }
  if (section === "autenticacion") {
    return [
      { id: "ldap", label: "LDAP", icon: Network },
      { id: "oauth", label: "OAuth", icon: KeyRound },
      { id: "sso", label: "SSO", icon: ShieldCheck },
    ];
  }
  if (section === "monitor") {
    return [
      ...(allowed(view, "monitor.view")
        ? [
            { id: "monitor" as const, label: "Monitor de sistema", icon: Activity },
            { id: "logs" as const, label: "Logs de sistema", icon: ScrollText },
          ]
        : []),
      ...(allowed(view, "admin.access") ? [{ id: "espacio" as const, label: "Espacio", icon: HardDrive }] : []),
      ...(allowed(view, "space.manage") ? [{ id: "asignado" as const, label: "Espacio asignado", icon: PieChart }] : []),
      ...(allowed(view, "sources.manage") ? [{ id: "fuentes" as const, label: "Fuentes", icon: Database }] : []),
    ];
  }
  if (section === "apariencia") {
    return [
      { id: "diseno", label: "Diseño", icon: LayoutTemplate },
      { id: "temas", label: "Temas", icon: Palette },
    ];
  }
  return [];
}

function allowed(view: AdminView, key: string) {
  return view.owner || view.actorPermissions.includes(key);
}

function visibleNav(view: AdminView) {
  return NAV.filter((item) => !item.need || item.need.some((key) => allowed(view, key)));
}

export function AdminScreen() {
  const { user, isPending } = useCurrentUserState();
  const [view, setState] = useState<State | null>(null);
  // Dónde estaba: solo al recargar la página; entrar de nuevo empieza desde el principio.
  const [section, setSection] = useState<Section | null>(() => readNav().section);
  const [leaf, setLeaf] = useState<Leaf | null>(() => readNav().leaf);
  const [roleId, setRoleId] = useState<string | null>(() => readNav().roleId);
  const autoMenu = useAutoContextMenu();
  useSaveOnReload(NAV_KEY, { section, leaf, roleId });
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<{ elastic: string; bucket: string } | null>(null);

  const load = () => {
    void adminState()
      .then((next) => {
        setState(next);
        if (next.isAdmin && user?.id) {
          setAccountProfile({
            userId: user.id,
            displayName: next.displayName,
            contactEmail: next.contactEmail,
            loginName: next.loginName,
            isAdmin: next.owner,
            canAdmin: true,
          });
          setPluginFlags(Object.fromEntries(next.plugins.map((plugin) => [plugin.id, plugin.enabled])));
        }
      })
      .catch(() => setError(t("No se pudo leer la administración.")));
  };

  useEffect(() => {
    if (user?.id) useVault.getState().openVaultFor(user.id);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    load();
  }, [user?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role=menu], [cmdk-root]")) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("[role=menu]") ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
          target.blur();
        }
        return;
      }
      if (roleId || leaf || section) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setRoleId(null);
        setLeaf(null);
        setSection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [roleId, leaf, section]);

  if (isPending || (user && !view && !error)) {
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center text-sm text-muted">{t("Cargando…")}</p>
      </AppFrame>
    );
  }
  if (!user) return <RedirectToSignIn />;
  if (error) {
    return (
      <AppFrame>
        <p className="grid flex-1 place-items-center text-sm text-danger">{t(error)}</p>
      </AppFrame>
    );
  }
  if (!view?.isAdmin) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
        <div className="text-center">
          <h1 className="font-serif text-3xl">{t("Sin permiso")}</h1>
          <Link to="/" className="mt-4 inline-flex h-11 items-center text-sm text-accent">
            {t("Volver a la bóveda")}
          </Link>
        </div>
      </main>
    );
  }

  if (view.mustChangePassword) return <Navigate to="/" />;

  const items = visibleNav(view);
  const current = items.find((item) => item.id === section) ?? null;
  const openSection = (id: Section) => {
    setSection(id);
    setLeaf(null);
    setRoleId(null);
  };
  const title = heading(view, current?.id ?? null, leaf, roleId);
  // Administración › sección › subapartado › rol: cada paso lleva de vuelta a él.
  const leafLabel = current && leaf ? leavesOf(view, current.id).find((item) => item.id === leaf)?.label : null;
  const crumbs: { label: string; go?: () => void }[] = current
    ? [
        {
          label: t("Administración"),
          go: () => {
            setSection(null);
            setLeaf(null);
            setRoleId(null);
          },
        },
        {
          label: t(current.label),
          go: leaf
            ? () => {
                setLeaf(null);
                setRoleId(null);
              }
            : undefined,
        },
        ...(leaf
          ? [{ label: leafLabel ? t(leafLabel) : title, go: roleId ? () => setRoleId(null) : undefined }]
          : []),
        ...(roleId ? [{ label: title }] : []),
      ]
    : [];

  return (
    <AppFrame>
      <div data-ui="panes" className="flex min-h-0 flex-1">
        <SettingsNav
          title={t("Ajustes")}
          allLabel={t("Todas")}
          items={items}
          active={current?.id ?? null}
          subItems={current ? leavesOf(view, current.id) : []}
          activeSub={leaf}
          onSelectSub={(id) => {
            setLeaf(id);
            setRoleId(null);
          }}
          onSelect={(id) => {
            if (id) openSection(id);
            else {
              setSection(null);
              setLeaf(null);
              setRoleId(null);
            }
          }}
          footer={view.loginName}
        />
        <div data-ui="workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            data-ui="admin-content"
            className="min-h-0 flex-1 overflow-y-auto"
            // En un subapartado, clic derecho en cualquier parte: lo mismo que sus botones.
            onContextMenu={leaf ? autoMenu.onContextMenu : undefined}
          >
            <div className="grafito-in w-full px-4 py-6 sm:px-8">
              {current ? (
                <nav data-ui="breadcrumb" data-menu-skip aria-label={t("Ruta")} className="mb-2 flex flex-wrap items-center gap-1 text-xs text-faint">
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.label} className="flex items-center gap-1">
                      {index > 0 ? <ChevronRight className="size-3 shrink-0" /> : null}
                      {crumb.go ? (
                        <button type="button" onClick={crumb.go} className="hover:text-fg">
                          {crumb.label}
                        </button>
                      ) : (
                        <span aria-current="page" className="text-muted">
                          {crumb.label}
                        </span>
                      )}
                    </span>
                  ))}
                </nav>
              ) : null}
              <h1 className="font-serif text-3xl tracking-tight">{title}</h1>
              {autoMenu.element}
              <div className="mt-6">
                {!current ? <OptionGrid items={items} onPick={openSection} /> : null}
                {current?.id === "usuarios" && !leaf ? (
                  allowed(view, "users.create") ||
                  allowed(view, "users.update") ||
                  allowed(view, "users.delete") ||
                  allowed(view, "roles.manage") ||
                  allowed(view, "orgs.manage") ||
                  allowed(view, "space.manage") ? (
                    <OptionGrid items={leavesOf(view, "usuarios")} onPick={(id) => setLeaf(id)} />
                  ) : (
                    <p className="text-sm text-muted">{t("Este rol no administra cuentas.")}</p>
                  )
                ) : null}
                {current?.id === "usuarios" && leaf === "usuarios" ? <UsersBoard view={view} reload={load} /> : null}
                {current?.id === "usuarios" && leaf === "organizaciones" ? <OrgsBoard view={view} /> : null}
                {current?.id === "usuarios" && leaf === "cuotas" ? <QuotaBoard view="users" /> : null}
                {current?.id === "usuarios" && leaf === "cuotas-portafolio" ? <QuotaBoard view="portfolios" /> : null}
                {current?.id === "usuarios" && leaf === "espacios-trabajo" ? <WorkspaceBoard /> : null}
                {current?.id === "usuarios" && leaf === "roles" ? (
                  <RolesBoard view={view} reload={load} roleId={roleId} onOpen={setRoleId} />
                ) : null}
                {current?.id === "autenticacion" && !leaf ? (
                  <OptionGrid items={leavesOf(view, "autenticacion")} onPick={(id) => setLeaf(id)} />
                ) : null}
                {current?.id === "autenticacion" && leaf === "ldap" ? <LdapPanel /> : null}
                {current?.id === "autenticacion" && leaf === "oauth" ? <OAuthPanel /> : null}
                {current?.id === "autenticacion" && leaf === "sso" ? <SsoPanel /> : null}
                {current?.id === "monitor" && !leaf ? (
                  <OptionGrid items={leavesOf(view, "monitor")} onPick={(id) => setLeaf(id)} />
                ) : null}
                {current?.id === "monitor" && leaf === "monitor" ? <MonitorBoard /> : null}
                {current?.id === "monitor" && leaf === "logs" ? <LogsBoard /> : null}
                {current?.id === "monitor" && leaf === "espacio" ? <SpacePanel /> : null}
                {current?.id === "monitor" && leaf === "asignado" ? <AssignedSpaceBoard /> : null}
                {current?.id === "monitor" && leaf === "fuentes" ? (
                  <Sources
                    view={view}
                    probe={probe}
                    reload={load}
                    onProbe={() => {
                      void probeSources().then((result) =>
                        setProbe({
                          elastic: result.elastic?.detail ?? "",
                          bucket: result.bucket?.detail ?? "",
                        }),
                      );
                    }}
                  />
                ) : null}
                {current?.id === "apariencia" && !leaf ? (
                  <OptionGrid items={leavesOf(view, "apariencia")} onPick={(id) => setLeaf(id)} />
                ) : null}
                {current?.id === "apariencia" && leaf === "temas" ? <ThemesPanel /> : null}
                {current?.id === "apariencia" && leaf === "diseno" ? <DesignPanel /> : null}
                {current?.id === "ia" ? <AiBoard /> : null}
                {current?.id === "correo" ? <MailBoard /> : null}
                {current?.id === "plugins" ? <Plugins view={view} reload={load} /> : null}
                {current?.id === "sesion" ? <SessionPanel seconds={view.sessionTtl} /> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

function heading(view: AdminView, section: Section | null, leaf: Leaf | null, roleId: string | null) {
  if (!section) return t("Administración");
  if (section === "usuarios" && leaf === "usuarios") return t("Usuarios");
  if (section === "usuarios" && leaf === "roles") {
    return view.roles.find((role) => role.id === roleId)?.name ?? t("Roles");
  }
  if (section === "usuarios" && leaf === "organizaciones") return t("Organizaciones");
  if (section === "usuarios" && leaf === "cuotas") return t("Espacio por usuario");
  if (section === "usuarios" && leaf === "cuotas-portafolio") return t("Espacio por portafolio");
  if (section === "usuarios" && leaf === "espacios-trabajo") return t("Espacios de trabajo");
  if (section === "usuarios") return t("Usuarios y permisos");
  if (section === "autenticacion" && leaf === "ldap") return "LDAP";
  if (section === "autenticacion" && leaf === "oauth") return t("OAuth");
  if (section === "autenticacion" && leaf === "sso") return "SSO";
  if (section === "apariencia" && leaf === "temas") return t("Temas");
  if (section === "apariencia" && leaf === "diseno") return t("Diseño");
  if (section === "apariencia") return t("Apariencia");
  if (section === "monitor" && leaf === "monitor") return t("Monitor de sistema");
  if (section === "monitor" && leaf === "logs") return t("Logs de sistema");
  if (section === "monitor" && leaf === "espacio") return t("Espacio");
  if (section === "monitor" && leaf === "asignado") return t("Espacio asignado");
  if (section === "monitor" && leaf === "fuentes") return t("Fuentes");
  if (section === "monitor") return t("Monitorización y logs");
  return t(NAV.find((item) => item.id === section)?.label ?? "Administración");
}

function Sources({
  view,
  probe,
  reload,
  onProbe,
}: {
  view: Extract<State, { isAdmin: true }>;
  probe: { elastic: string; bucket: string } | null;
  reload: () => void;
  onProbe: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <ul>
        {view.sources.map((source) => (
          <li key={source.id} className="flex items-center gap-4 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t(source.label)}</p>
              <p className="mt-0.5 text-xs text-muted">
                {engineLabel(source.id, view.engines)}
                {source.id === "documents" ? ` · ${view.indexed}` : ""}
              </p>
            </div>
            <Switch
              checked={source.enabled}
              ariaLabel={t(source.label)}
              onChange={(enabled) => void setSourceEnabled({ data: { id: source.id, enabled } }).then(reload)}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={onProbe} className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated">
          {t("Comprobar")}
        </button>
        {probe ? (
          <div className="min-w-0 text-xs text-muted">
            <p className="truncate">{probe.elastic}</p>
            <p className="truncate">{probe.bucket}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Plugins({ view, reload }: { view: Extract<State, { isAdmin: true }>; reload: () => void }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <ul>
        {view.plugins.map((plugin) => (
          <li key={plugin.id} className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t(plugin.name)}</p>
            </div>
            <Switch
              checked={plugin.enabled}
              ariaLabel={t(plugin.name)}
              onChange={(enabled) => void setPluginEnabled({ data: { id: plugin.id, enabled } }).then(reload)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ThemesPanel() {
  const [current, setCurrent] = useState<ThemeId>("grafito");
  useEffect(() => setCurrent(currentTheme()), []);
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            aria-pressed={current === theme.id}
            onClick={() => {
              applyTheme(theme.id);
              setCurrent(theme.id);
            }}
            className="theme-card"
          >
            <span className="theme-stage" data-preview={theme.id}>
              <b>{t(theme.name)}</b>
              <span>{t("Aa — nota, vínculo, archivo")}</span>
            </span>
            <span className="theme-card-copy">
              <strong className="text-sm">{t(theme.name)}</strong>
              {current === theme.id ? <em className="ml-2 text-xs text-accent not-italic">{t("En uso")}</em> : null}
              <small>{t(theme.blurb)}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SessionPanel({ seconds }: { seconds: number }) {
  const [picked, setPicked] = useState(seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setPicked(seconds), [seconds]);
  const dirty = picked !== seconds;

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <ul>
        {SESSION_PRESETS.map((item) => (
          <li key={item.seconds} className="border-b border-line last:border-b-0">
            <button
              type="button"
              aria-pressed={picked === item.seconds}
              onClick={() => setPicked(item.seconds)}
              className={`flex h-14 w-full items-center gap-3 px-4 text-left text-sm transition-colors ${
                picked === item.seconds ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
              }`}
            >
              <span className={`size-2 rounded-full ${picked === item.seconds ? "bg-accent" : "bg-line"}`} />
              {t(item.label)}
              {seconds === item.seconds ? <span className="ml-auto text-xs text-faint">{t("Actual")}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void setSessionTtl({ data: { seconds: picked } })
              .then((result) => {
                if (!result.ok) {
                  setError(t("No se aplicó."));
                  setBusy(false);
                  return;
                }
                void leaveApp();
              })
              .catch(() => {
                setError(t("No se aplicó."));
                setBusy(false);
              });
          }}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy ? t("Cerrando…") : t("Aplicar y salir")}
        </button>
        {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
      </div>
    </section>
  );
}

function SpacePanel() {
  const [stores, setStores] = useState<StoreSpace[] | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    void storageReport()
      .then((next) => {
        if (!next.ok) {
          setError(t("Sin permiso."));
          return;
        }
        setStores(next.stores);
      })
      .catch(() => setError(t("No se pudo medir.")));
  };

  useEffect(() => {
    load();
  }, []);

  if (error) return <p className="text-sm text-danger">{t(error)}</p>;
  if (!stores) return <p className="text-sm text-muted">{t("Cargando…")}</p>;
  if (stores.length === 0) return <p className="text-sm text-muted">{t("Ninguna base conectada.")}</p>;

  return (
    <div className="space-y-4">
      <div className="flex">
        <button type="button" onClick={load} className="ml-auto h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated">
          {t("Actualizar")}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {stores.map((store) => {
          const measured = store.total != null && store.available != null && store.total > 0;
          const percent = measured
            ? Math.max(0, Math.min(100, Math.round(((store.total! - store.available!) / store.total!) * 100)))
            : 0;
          return (
            <div key={store.id} className="border border-line bg-surface p-4">
              <p className="text-xs tracking-widest text-faint uppercase">{t(store.label)}</p>
              {measured ? (
                <>
                  <p className="mt-1 font-serif text-3xl">{formatBytes(store.available!)}</p>
                  <p className="mt-1 text-xs text-muted">
                    {t("Disponible de")}{" "}{formatBytes(store.total!)}
                    {store.used != null ? ` · base ${formatBytes(store.used)}` : ""}
                  </p>
                  <UsageMeter percent={percent} label={t("Uso de {0}", { 0: store.label })} />
                </>
              ) : (
                <>
                  <p className="mt-1 font-serif text-3xl">{store.used != null ? formatBytes(store.used) : "—"}</p>
                  <p className="mt-1 text-xs text-muted">{t("Ocupado")}</p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function engineLabel(id: string, engines: { relational: string; documents: string; files: string }): string {
  if (id === "relational") return engines.relational === "postgres" ? t("Postgres") : t("Postgres embebido");
  if (id === "documents") return engines.documents === "elasticsearch" ? t("Elasticsearch") : t("Índice de Postgres");
  return engines.files === "minio" ? t("MinIO") : t("Postgres");
}
