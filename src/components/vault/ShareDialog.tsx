import { copyText } from "@/lib/clipboard";
import { Building2, Check, Eye, Globe, Link2, Lock, Pencil, ShieldCheck, User, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { publicUrl, setMyShares, shareOf, useMyShares } from "@/app/shares";
import { useVault } from "@/app/vault/store";
import { AccessTrail, chosenExpiry, ExpiryField, utcDay } from "@/components/vault/AccessWindow";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { orgPath } from "@/domain/orgs";
import type { ExpiryChoice } from "@/domain/access-window";
import type { ShareKind, Visibility } from "@/domain/share";
import { revokePublicShare, revokeShareGrant, setShare, shareOrgs, shareTrail, shareUsers } from "@/server/share.functions";
import { t } from "@/app/i18n";

type Candidate = Awaited<ReturnType<typeof shareUsers>>[number];
type OrgCandidate = Awaited<ReturnType<typeof shareOrgs>>[number];

/** Elegir quién ve una nota o un portafolio (privada, con usuarios u organizaciones, pública) y si pueden editarla. */
export function ShareDialog({ kind, id, onClose }: { kind: ShareKind; id: string; onClose: () => void }) {
  const shares = useMyShares();
  const title = useVault((state) =>
    kind === "document"
      ? (state.documents.find((document) => document.id === id)?.title ?? "")
      : (state.portfolios.find((portfolio) => portfolio.id === id)?.name ?? ""),
  );
  const current = shareOf(shares, kind, id);
  const [visibility, setVisibility] = useState<Visibility>(current?.visibility ?? "private");
  const [access, setAccess] = useState<"read" | "edit" | "admin">(current?.access ?? "read");
  const [selected, setSelected] = useState<Set<string>>(new Set(current?.userIds ?? []));
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set(current?.orgIds ?? []));
  const [people, setPeople] = useState<Candidate[] | null>(null);
  const [orgs, setOrgs] = useState<OrgCandidate[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [grantMode, setGrantMode] = useState<ExpiryChoice>("never");
  const [grantDate, setGrantDate] = useState("");
  const [grantTouched, setGrantTouched] = useState(false);
  const [linkMode, setLinkMode] = useState<ExpiryChoice>("never");
  const [linkDate, setLinkDate] = useState("");
  const [linkTouched, setLinkTouched] = useState(false);
  const [trail, setTrail] = useState<Awaited<ReturnType<typeof shareTrail>> | null>(null);

  const uniform = useMemo(() => {
    const all = [...(current?.grants ?? []), ...(current?.orgGrants ?? [])];
    if (all.length === 0) return { mixed: false, at: null as number | null };
    const first = all[0]?.expiresAt ?? null;
    const mixed = all.some((grant) => (grant.expiresAt ?? null) !== first);
    return { mixed, at: mixed ? null : first };
  }, [current]);

  const linkExisting = useMemo(() => {
    const at = current?.linkExpiresAt ?? null;
    if (current?.publicToken) return at;
    return at && at > Date.now() ? at : null;
  }, [current]);

  useEffect(() => {
    if (grantTouched) return;
    setGrantMode(uniform.at ? "date" : "never");
    setGrantDate(uniform.at ? utcDay(uniform.at) : "");
  }, [uniform.at, grantTouched]);

  useEffect(() => {
    if (linkTouched) return;
    setLinkMode(linkExisting ? "date" : "never");
    setLinkDate(linkExisting ? utcDay(linkExisting) : "");
  }, [linkExisting, linkTouched]);

  const loadTrail = () => {
    void shareTrail({ data: { kind, targetId: id } })
      .then(setTrail)
      .catch(() => setTrail({ periods: [], events: [] }));
  };

  useEffect(() => {
    void shareUsers()
      .then(setPeople)
      .catch(() => setPeople([]));
    void shareOrgs()
      .then(setOrgs)
      .catch(() => setOrgs([]));
    loadTrail();
  }, [kind, id]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (people ?? []).filter(
      (person) => !needle || person.name.toLowerCase().includes(needle) || person.loginName.toLowerCase().includes(needle),
    );
  }, [people, query]);

  const filteredOrgs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return orgs
      .map((org) => ({ ...org, path: orgPath(orgs, org.id) }))
      .filter((org) => !needle || org.path.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path, "es"));
  }, [orgs, query]);

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const save = async () => {
    if ((visibility === "shared" && grantTouched && grantMode === "date" && !grantDate) || (visibility === "public" && linkTouched && linkMode === "date" && !linkDate)) {
      setError(t("Elige una fecha."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const expiresAt =
        visibility === "shared" ? chosenExpiry(grantTouched, uniform.mixed, grantMode, grantDate, uniform.at) : undefined;
      const linkExpiresAt = visibility === "public" ? chosenExpiry(linkTouched, false, linkMode, linkDate, linkExisting) : undefined;
      const result = await setShare({
        data: {
          kind,
          targetId: id,
          title,
          visibility,
          access,
          userIds: [...selected],
          orgIds: [...selectedOrgs],
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(linkExpiresAt !== undefined ? { linkExpiresAt } : {}),
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setGrantTouched(false);
      setLinkTouched(false);
      setMyShares(result.shares);
      loadTrail();
      if (visibility !== "public") onClose();
    } catch {
      setError(t("No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  };

  const dropGrant = async (subjectKind: "user" | "org", subjectId: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await revokeShareGrant({ data: { kind, targetId: id, subjectKind, subjectId } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMyShares(result.shares);
      if (subjectKind === "user") setSelected((prev) => { const next = new Set(prev); next.delete(subjectId); return next; });
      else setSelectedOrgs((prev) => { const next = new Set(prev); next.delete(subjectId); return next; });
      loadTrail();
    } catch {
      setError(t("No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  };

  const dropLink = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await revokePublicShare({ data: { kind, targetId: id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinkTouched(false);
      setMyShares(result.shares);
      loadTrail();
    } catch {
      setError(t("No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  };

  const link = current?.visibility === "public" && current.publicToken ? publicUrl(current.publicToken) : null;

  return (
    <Modal title={t("Compartir «{0}»", { 0: title })} onClose={onClose}>
      <div className="space-y-2" role="radiogroup" aria-label={t("Visibilidad")}>
        <Choice active={visibility === "private"} onClick={() => setVisibility("private")} icon={<Lock className="size-4" />}>
          <strong className="font-medium">{t("Privada")}</strong>
        </Choice>
        <Choice active={visibility === "shared"} onClick={() => setVisibility("shared")} icon={<Users className="size-4" />}>
          <strong className="font-medium">{t("Compartida")}</strong>
        </Choice>
        <Choice active={visibility === "public"} onClick={() => setVisibility("public")} icon={<Globe className="size-4" />}>
          <strong className="font-medium">{t("Pública")}</strong>
        </Choice>
      </div>

      {visibility === "shared" ? (
        <div className="mt-4 space-y-2">
          <div className={`grid gap-2 ${kind === "portfolio" ? "grid-cols-3" : "grid-cols-2"}`} role="radiogroup" aria-label={t("Permiso")}>
            <Choice active={access === "read"} onClick={() => setAccess("read")} icon={<Eye className="size-4" />}>
              {t("Solo lectura")}
            </Choice>
            <Choice active={access === "edit"} onClick={() => setAccess("edit")} icon={<Pencil className="size-4" />}>
              {t("Puede editar")}
            </Choice>
            {kind === "portfolio" ? (
              <Choice active={access === "admin"} onClick={() => setAccess("admin")} icon={<ShieldCheck className="size-4" />}>
                {t("Administrador")}
              </Choice>
            ) : null}
          </div>
          <ExpiryField
            mode={grantMode}
            date={grantDate}
            mixed={uniform.mixed && !grantTouched}
            onChange={(mode, date) => {
              setGrantTouched(true);
              setGrantMode(mode);
              setGrantDate(date);
            }}
          />
          <SearchField value={query} onChange={setQuery} placeholder={t("Buscar usuario u organización")} />
          <ul className="max-h-56 overflow-y-auto rounded-md border border-line">
            {filteredOrgs.length > 0 ? <ListHeading>{t("Organizaciones")}</ListHeading> : null}
            {filteredOrgs.map((org) => (
              <CheckRow
                key={org.id}
                on={selectedOrgs.has(org.id)}
                icon={<Building2 className="size-3.5" />}
                label={org.path}
                onToggle={() => toggle(selectedOrgs, org.id, setSelectedOrgs)}
                onRevoke={current?.orgIds.includes(org.id) ? () => void dropGrant("org", org.id) : undefined}
              />
            ))}
            <ListHeading>{t("Usuarios")}</ListHeading>
            {people === null ? <li className="px-3 py-3 text-sm text-muted">{t("Cargando…")}</li> : null}
            {people !== null && filtered.length === 0 ? (
              <li className="px-3 py-3 text-sm text-muted">{t("Ningún usuario coincide.")}</li>
            ) : null}
            {filtered.map((person) => (
              <CheckRow
                key={person.id}
                on={selected.has(person.id)}
                icon={<User className="size-3.5" />}
                label={person.name}
                hint={person.loginName}
                onToggle={() => toggle(selected, person.id, setSelected)}
                onRevoke={current?.userIds.includes(person.id) ? () => void dropGrant("user", person.id) : undefined}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {visibility === "public" ? (
        <div className="mt-4 space-y-3">
          <ExpiryField
            mode={linkMode}
            date={linkDate}
            onChange={(mode, date) => {
              setLinkTouched(true);
              setLinkMode(mode);
              setLinkDate(date);
            }}
          />
          {link ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2">
              <Link2 className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-xs text-muted" title={link}>
                {link}
              </span>
              <button
                type="button"
                onClick={() => {
                  void copyText(link).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="shrink-0 text-sm text-accent underline-offset-4 hover:underline"
              >
                {copied ? t("Copiado") : t("Copiar")}
              </button>
              <button type="button" disabled={busy} onClick={() => void dropLink()} className="shrink-0 text-sm text-danger underline-offset-4 hover:underline disabled:opacity-60">
                {t("Revocar enlace")}
              </button>
            </div>
          ) : current?.linkRevokedAt ? (
            <p className="text-xs text-muted">{t("El enlace ya no sirve.")}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">{trail ? <AccessTrail periods={trail.periods} events={trail.events} /> : <p className="text-xs text-muted">{t("Cargando…")}</p>}</div>

      {error ? <p className="mt-3 text-sm text-danger">{t(error)}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg">
          {link && visibility === "public" ? t("Cerrar") : t("Cancelar")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {busy ? t("Guardando…") : visibility === "public" && !link ? (current?.linkRevokedAt ? t("Nuevo enlace") : t("Crear enlace")) : t("Guardar")}
        </button>
      </div>
    </Modal>
  );
}

function Choice({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm ${
        active ? "border-accent bg-elevated" : "border-line hover:bg-elevated"
      }`}
    >
      <span className={active ? "text-accent" : "text-faint"}>{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function ListHeading({ children }: { children: ReactNode }) {
  return (
    <li className="sticky top-0 border-b border-line bg-surface px-3 py-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
      {children}
    </li>
  );
}

function CheckRow({
  on,
  icon,
  label,
  hint,
  onToggle,
  onRevoke,
}: {
  on: boolean;
  icon: ReactNode;
  label: string;
  hint?: string;
  onToggle: () => void;
  onRevoke?: () => void;
}) {
  return (
    <li className="flex items-stretch border-b border-line last:border-b-0">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-3 text-left text-sm hover:bg-elevated"
      >
        <span className={`grid size-4 shrink-0 place-items-center border ${on ? "border-accent bg-accent text-accent-fg" : "border-line"}`}>
          {on ? <Check className="size-3" /> : null}
        </span>
        <span className="shrink-0 text-faint">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint ? <span className="text-xs text-faint">{t(hint)}</span> : null}
      </button>
      {onRevoke ? (
        <button type="button" onClick={onRevoke} className="shrink-0 px-3 text-xs text-danger hover:bg-elevated">
          {t("Revocar")}
        </button>
      ) : null}
    </li>
  );
}
