import { subtreeIds } from "./hierarchy.ts";

/** Hierarchical organizations; null parentId denotes a root. */
export type Org = { id: string; name: string; parentId: string | null };

/** Direct children sorted by name. */
export function childOrgs<T extends Org>(orgs: readonly T[], parentId: string | null): T[] {
  return orgs
    .filter((org) => org.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/** The organization and all descendants. */
export function orgSubtree(orgs: readonly Org[], id: string): Set<string> {
  return subtreeIds(orgs, id);
}

/** Example breadcrumb: Company › Sales › North. */
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

/** Whether moving id beneath parentId would create a cycle. */
export function wouldCycle(orgs: readonly Org[], id: string, parentId: string | null): boolean {
  return parentId !== null && orgSubtree(orgs, id).has(parentId);
}
