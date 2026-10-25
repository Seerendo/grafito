/** Organizaciones jerárquicas: `parentId` nulo es una organización raíz. */
export type Org = { id: string; name: string; parentId: string | null };

/** Hijas directas, ordenadas por nombre. */
export function childOrgs<T extends Org>(orgs: readonly T[], parentId: string | null): T[] {
  return orgs
    .filter((org) => org.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/** La organización y todas sus sub-organizaciones. */
export function orgSubtree(orgs: readonly Org[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const org of orgs) {
      if (org.parentId && ids.has(org.parentId) && !ids.has(org.id)) {
        ids.add(org.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** «Empresa › Ventas › Norte». */
export function orgPath(orgs: readonly Org[], id: string): string {
  const byId = new Map(orgs.map((org) => [org.id, org]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" › ");
}

/** Mover `id` bajo `parentId` crearía un ciclo. */
export function wouldCycle(orgs: readonly Org[], id: string, parentId: string | null): boolean {
  return parentId !== null && orgSubtree(orgs, id).has(parentId);
}
