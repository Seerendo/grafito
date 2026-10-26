import { Building2, ChevronRight, Plus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SearchField } from "@/components/ui/SearchField";
import { TextAction } from "@/components/ui/TextAction";
import { childOrgs, orgPath, orgSubtree } from "@/domain/orgs";
import {
  createOrgFn,
  deleteOrgFn,
  orgsState,
  renameOrgFn,
  setOrgMembersFn,
} from "@/server/orgs.functions";
import type { AdminView } from "./Boards";
import { t } from "@/app/i18n";

type OrgRow = Extract<Awaited<ReturnType<typeof orgsState>>, { ok: true }>["orgs"][number];

/**
 * Organizaciones: árbol a la izquierda y la elegida a la derecha, con sus
 * sub-organizaciones y miembros. Compartir con una organización llega también
 * a los miembros de sus sub-organizaciones.
 */
export function OrgsBoard({ view }: { view: AdminView }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [name, setName] = useState("");

  const load = () =>
    orgsState()
      .then((result) => {
        if (!result.ok) setError(t("Sin permiso para administrar organizaciones."));
        else setOrgs(result.orgs);
      })
      .catch(() => setError(t("No se pudieron leer las organizaciones.")));

  useEffect(() => {
    void load();
  }, []);

  const current = orgs?.find((org) => org.id === selected) ?? null;

  const create = async () => {
    if (!creating) return;
    setError("");
    const result = await createOrgFn({ data: { name, parentId: creating.parentId } });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreating(null);
    setName("");
    await load();
    setSelected(result.id);
  };

  if (error && !orgs) return <p className="text-sm text-danger">{t(error)}</p>;
  if (!orgs) return <p className="text-sm text-muted">{t("Cargando…")}</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div className="rounded-lg border border-line bg-surface p-2">
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-xs font-semibold tracking-wider text-muted uppercase">{t("Organizaciones")}</span>
          <button
            type="button"
            onClick={() => {
              setCreating({ parentId: null });
              setName("");
            }}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-accent hover:text-fg"
          >
            <Plus className="size-3.5" />
            {t("Nueva")}
          </button>
        </div>
        {orgs.length === 0 ? <p className="px-2 py-3 text-sm text-muted">{t("Todavía no hay organizaciones.")}</p> : null}
        <OrgTree orgs={orgs} parentId={null} depth={0} selected={selected} onSelect={setSelected} />
      </div>

      <div className="min-w-0 space-y-4">
        {creating ? (
          <form
            className="flex flex-wrap gap-2 rounded-lg border border-line bg-surface p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <p className="w-full text-xs text-muted">
              {creating.parentId ? t("Nueva sub-organización de {0}", { 0: orgPath(orgs, creating.parentId) }) : t("Nueva organización raíz")}
            </p>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t("Nombre de la organización")}
              placeholder={t("Nombre")}
              autoFocus
              required
              className="h-11 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-sm"
            />
            <button type="submit" className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
              {t("Crear")}
            </button>
            <button type="button" onClick={() => setCreating(null)} className="h-11 rounded-md px-4 text-sm text-muted hover:text-fg">
              {t("Cancelar")}
            </button>
          </form>
        ) : null}
        {error ? <p className="text-sm text-danger">{t(error)}</p> : null}
        {current ? (
          <OrgDetail
            key={current.id}
            org={current}
            orgs={orgs}
            view={view}
            reload={load}
            onError={setError}
            onCreateChild={() => {
              setCreating({ parentId: current.id });
              setName("");
            }}
            onDeleted={() => {
              setSelected(current.parentId);
              void load();
            }}
          />
        ) : (
null
        )}
      </div>
    </div>
  );
}

function OrgTree({
  orgs,
  parentId,
  depth,
  selected,
  onSelect,
}: {
  orgs: OrgRow[];
  parentId: string | null;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const children = childOrgs(orgs, parentId);
  if (children.length === 0) return null;
  return (
    <ul>
      {children.map((org) => {
        const on = org.id === selected;
        const subs = childOrgs(orgs, org.id).length;
        return (
          <li key={org.id}>
            <button
              type="button"
              onClick={() => onSelect(org.id)}
              aria-current={on ? "true" : undefined}
              className={`flex h-9 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm ${
                on ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {subs > 0 ? <ChevronRight className="size-3.5 shrink-0 rotate-90 text-faint" /> : <span className="w-3.5 shrink-0" />}
              <Building2 className={`size-3.5 shrink-0 ${on ? "text-accent" : "text-faint"}`} />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              <span className="shrink-0 text-[11px] text-faint tabular-nums">{org.memberIds.length}</span>
            </button>
            <OrgTree orgs={orgs} parentId={org.id} depth={depth + 1} selected={selected} onSelect={onSelect} />
          </li>
        );
      })}
    </ul>
  );
}

function OrgDetail({
  org,
  orgs,
  view,
  reload,
  onError,
  onCreateChild,
  onDeleted,
}: {
  org: OrgRow;
  orgs: OrgRow[];
  view: AdminView;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  onCreateChild: () => void;
  onDeleted: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(org.name);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const members = new Set(org.memberIds);
  const subtree = orgSubtree(orgs, org.id);
  const reach = new Set(orgs.filter((item) => subtree.has(item.id)).flatMap((item) => item.memberIds));
  const name = (userId: string) => view.users.find((person) => person.id === userId)?.name ?? t("Usuario borrado");

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return view.users
      .filter((person) => !members.has(person.id))
      .filter(
        (person) =>
          !needle || person.name.toLowerCase().includes(needle) || (person.loginName ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 8);
    // `members` se deriva de `org.memberIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, view.users, org.memberIds]);

  const saveMembers = async (next: string[]) => {
    const result = await setOrgMembersFn({ data: { id: org.id, userIds: next } });
    if (!result.ok) onError(result.error);
    await reload();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-xs text-faint">{orgPath(orgs, org.id)}</p>
        {renaming ? (
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void renameOrgFn({ data: { id: org.id, name: draft } }).then(async (result) => {
                if (!result.ok) onError(result.error);
                else {
                  setRenaming(false);
                  await reload();
                }
              });
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={t("Nuevo nombre")}
              autoFocus
              className="h-11 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-sm"
            />
            <button type="submit" className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
              {t("Guardar")}
            </button>
            <button type="button" onClick={() => setRenaming(false)} className="h-11 rounded-md px-4 text-sm text-muted hover:text-fg">
              {t("Cancelar")}
            </button>
          </form>
        ) : (
          <h2 className="mt-1 font-serif text-2xl">{org.name}</h2>
        )}
        <p className="mt-2 text-sm text-muted">
          {org.memberIds.length}{" "}{t("miembros directos ·")}{" "}{reach.size}{" "}{t("con sus sub-organizaciones")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <TextAction onClick={onCreateChild}>{t("Nueva sub-organización")}</TextAction>
          {!renaming ? <TextAction onClick={() => { setDraft(org.name); setRenaming(true); }}>{t("Renombrar")}</TextAction> : null}
          {confirming ? (
            <span className="flex items-center gap-3 text-sm">
              <span className="text-muted">{t("¿Borrar con sus sub-organizaciones?")}</span>
              <TextAction
                tone="danger"
                onClick={() => {
                  void deleteOrgFn({ data: { id: org.id } }).then((result) => {
                    if (!result.ok) onError(result.error);
                    else onDeleted();
                  });
                }}
              >
                {t("Sí")}
              </TextAction>
              <TextAction onClick={() => setConfirming(false)}>{t("No")}</TextAction>
            </span>
          ) : (
            <TextAction tone="danger" onClick={() => setConfirming(true)}>
              {t("Eliminar")}
            </TextAction>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Users className="size-4 text-faint" />
          <span className="text-xs font-semibold tracking-wider text-muted uppercase">{t("Miembros")}</span>
          <span className="rounded-full bg-elevated px-1.5 text-[11px] leading-5 text-muted tabular-nums">{org.memberIds.length}</span>
        </div>
        {org.memberIds.length === 0 ? <p className="px-4 py-3 text-sm text-muted">{t("Sin miembros todavía.")}</p> : null}
        <ul>
          {org.memberIds
            .map((userId) => ({ userId, name: name(userId) }))
            .sort((a, b) => a.name.localeCompare(b.name, "es"))
            .map((member) => (
              <li key={member.userId} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                <TextAction onClick={() => void saveMembers(org.memberIds.filter((item) => item !== member.userId))}>{t("Quitar")}</TextAction>
              </li>
            ))}
        </ul>
        <div className="border-t border-line p-3">
          <SearchField value={query} onChange={setQuery} placeholder={t("Añadir miembros: buscar usuario")} />
          {query.trim() ? (
            <ul className="mt-2">
              {candidates.length === 0 ? <li className="px-1 py-2 text-sm text-muted">{t("Ningún usuario coincide.")}</li> : null}
              {candidates.map((person) => (
                <li key={person.id} className="flex items-center gap-3 px-1 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{person.name}</span>
                  {person.loginName ? <span className="text-xs text-faint">{person.loginName}</span> : null}
                  <TextAction
                    onClick={() => {
                      setQuery("");
                      void saveMembers([...org.memberIds, person.id]);
                    }}
                  >
                    {t("Añadir")}
                  </TextAction>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
