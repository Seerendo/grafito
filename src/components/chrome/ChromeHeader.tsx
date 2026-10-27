import { File, FileText, LogOut, Search, Shield, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { initials, useAccountProfile } from "@/app/account-profile";
import { leaveApp } from "@/app/leave";
import { useVault } from "@/app/vault/store";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { Mark } from "@/components/brand/Mark";
import { t } from "@/app/i18n";

export function ChromeHeader() {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header data-ui="topbar" className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Link
          to="/"
          aria-label={t("Inicio")}
          onClick={() => useVault.getState().showStart()}
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-md pr-1 text-fg transition-opacity hover:opacity-80"
        >
          <Mark />
          <span className="font-semibold tracking-tight">{t("Grafito")}</span>
        </Link>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md bg-inset px-3 text-left text-sm text-muted"
        >
          <Search className="size-4 shrink-0" />
          <span className="truncate">{t("Buscar")}</span>
          <span className="ml-auto hidden text-xs text-faint lg:inline">{t("Ctrl K")}</span>
        </button>
        <AccountMenu />
      </header>
      {searchOpen ? <NoteSearch onClose={() => setSearchOpen(false)} /> : null}
    </>
  );
}

export function AccountMenu() {
  const profile = useAccountProfile();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Abierto con el ratón: al cerrarse, el botón suelta el foco para que no
  // quede recuadrado (con el teclado sí conserva el foco y su anillo).
  const byPointer = useRef(false);
  const letters = initials(profile.displayName);

  useEffect(() => {
    if (open || !byPointer.current) return;
    byPointer.current = false;
    if (document.activeElement === button.current) button.current?.blur();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (to: "/" | "/admin" | "/cuenta") => {
    setOpen(false);
    void navigate({ to });
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={t("Cuenta")}
        aria-expanded={open}
        aria-haspopup="menu"
        onPointerDown={() => {
          byPointer.current = true;
        }}
        onClick={() => setOpen((value) => !value)}
        className="grid h-11 w-11 place-items-center rounded-md [-webkit-tap-highlight-color:transparent]"
      >
        <span className="grid size-8 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
          {letters}
        </span>
      </button>
      {open ? (
        <div role="menu" data-ui="popover" className="absolute right-0 z-30 mt-1 w-56 rounded-md border border-line bg-surface py-1 shadow-2xl">
          <p className="truncate px-3 py-2 text-sm font-medium">{profile.displayName}</p>
          {(profile.isAdmin || profile.canAdmin) && pathname !== "/admin" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => go("/admin")}
              className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm text-fg"
            >
              <Shield className="size-4 text-muted" />
              {t("Administración")}
            </button>
          ) : null}
          {pathname !== "/cuenta" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => go("/cuenta")}
              className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm text-fg"
            >
              <UserRound className="size-4 text-muted" />
              {t("Cuenta")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void leaveApp();
            }}
            className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm text-fg"
          >
            <LogOut className="size-4 text-muted" />
            {t("Salir")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NoteSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const userId = useCurrentUser()?.id;
  const documents = useVault((view) => view.documents);

  useEffect(() => {
    if (userId) useVault.getState().openVaultFor(userId);
  }, [userId]);
  const portfolios = useVault((view) => view.portfolios);
  const portfolioName = (id: string | null) => portfolios.find((item) => item.id === id)?.name ?? t("Raíz");

  const openNote = (id: string) => {
    useVault.getState().setActive(id);
    onClose();
    void navigate({ to: "/" });
  };

  return (
    <div data-ui="overlay" className="fixed inset-0 z-40 flex items-start justify-center bg-inset/80 px-4 pt-24" onMouseDown={onClose}>
      <Command
        label={t("Buscar notas")}
        vimBindings={false}
        onMouseDown={(event) => event.stopPropagation()}
        data-ui="dialog"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-faint" />
          <Command.Input
            autoFocus
            placeholder={t("Buscar notas")}
            className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-sm text-muted">{t("Sin resultados")}</Command.Empty>
          <Command.Group heading={t("Notas")}>
            {documents.map((document) => (
              <Command.Item
                key={document.id}
                value={`${document.title} ${portfolioName(document.portfolioId)} ${document.content.slice(0, 180)}`}
                onSelect={() => openNote(document.id)}
              >
                <span className="flex h-11 items-center gap-2 px-2 text-sm">
                  {document.kind === "file" ? (
                    <File className="size-4 shrink-0 text-muted" />
                  ) : (
                    <FileText className="size-4 shrink-0 text-muted" />
                  )}
                  <span className="truncate">{document.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-faint">
                    {document.kind === "file" ? t("archivo") : portfolioName(document.portfolioId)}
                  </span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
