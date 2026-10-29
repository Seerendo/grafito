import { copyText } from "@/lib/clipboard";
import { Building2, Check, Eye, Globe, Link2, Lock, Pencil, ShieldCheck, User, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { publicUrl, setMyShares, shareOf, useMyShares } from "@/app/shares";
import { useVault } from "@/app/vault/store";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { orgPath } from "@/domain/orgs";
import type { ShareKind, Visibility } from "@/domain/share";
import { setShare, shareOrgs, shareUsers } from "@/server/share.functions";
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

  useEffect(() => {
    void shareUsers()
      .then(setPeople)
      .catch(() => setPeople([]));
    void shareOrgs()
      .then(setOrgs)
      .catch(() => setOrgs([]));
  }, []);

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
    setBusy(true);
    setError("");
    try {
      const result = await setShare({
        data: { kind, targetId: id, title, visibility, access, userIds: [...selected], orgIds: [...selectedOrgs] },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMyShares(result.shares);
      if (visibility !== "public") onClose();
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
              />
            ))}
          </ul>
        </div>
      ) : null}

      {visibility === "public" && link ? (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2">
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
        </div>
      ) : null}

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
          {busy ? t("Guardando…") : visibility === "public" && !link ? t("Crear enlace") : t("Guardar")}
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
}: {
  on: boolean;
  icon: ReactNode;
  label: string;
  hint?: string;
  onToggle: () => void;
}) {
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-elevated"
      >
        <span className={`grid size-4 shrink-0 place-items-center border ${on ? "border-accent bg-accent text-accent-fg" : "border-line"}`}>
          {on ? <Check className="size-3" /> : null}
        </span>
        <span className="shrink-0 text-faint">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint ? <span className="text-xs text-faint">{t(hint)}</span> : null}
      </button>
    </li>
  );
}
