import type { Portfolio } from "./types";

/**
 * Dónde queda la bóveda después de borrar, y qué carpetas hay que desplegar
 * en el directorio al abrir algo. Lógica pura: la usa el store y las pruebas.
 */

/** Desde `id` hasta la raíz, incluido `id`. Vacío si no hay carpeta. */
export function portfolioPath(
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
  id: string | null,
): string[] {
  if (!id) return [];
  const byId = new Map(portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return path;
}

/**
 * Despliega `id` y sus padres. En el directorio, `collapsed[id] === true`
 * significa plegado; `false` o ausente, abierto.
 */
export function expandTo(
  collapsed: Record<string, boolean>,
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
  id: string | null,
): Record<string, boolean> {
  const path = portfolioPath(portfolios, id);
  if (path.every((item) => !collapsed[item])) return collapsed;
  const next = { ...collapsed };
  for (const item of path) next[item] = false;
  return next;
}

export type DeleteLanding = {
  activeId: string | null;
  selectedPortfolioId: string | null;
  folderPicked: boolean;
  rootPicked: boolean;
};

/**
 * Si se está viendo justo lo que se borra, se abre su carpeta (o la Carpeta
 * Personal, si vivía en la raíz o la carpeta también se fue). Si se está
 * viendo otra cosa, `null`: no hay que cambiar de sitio.
 */
export function landingAfterDelete(input: {
  activeId: string | null;
  folderPicked: boolean;
  selectedPortfolioId: string | null;
  removedDocs: ReadonlySet<string>;
  removedPortfolios: ReadonlySet<string>;
  activeDocPortfolioId: string | null;
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[];
}): DeleteLanding | null {
  const docRemoved = input.activeId !== null && input.removedDocs.has(input.activeId);
  const folderRemoved =
    input.folderPicked &&
    input.selectedPortfolioId !== null &&
    input.removedPortfolios.has(input.selectedPortfolioId) &&
    input.activeId === null;
  if (!docRemoved && !folderRemoved) return null;
  const start = docRemoved ? input.activeDocPortfolioId : input.selectedPortfolioId;
  const landed = climb(start, input.removedPortfolios, input.portfolios);
  if (!landed) return { activeId: null, selectedPortfolioId: null, folderPicked: false, rootPicked: true };
  return { activeId: null, selectedPortfolioId: landed, folderPicked: true, rootPicked: false };
}

/** La primera carpeta de `start` hacia arriba que no se borró, o `null` (la raíz). */
export function climb(
  start: string | null,
  removed: ReadonlySet<string>,
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
): string | null {
  const byId = new Map(portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const seen = new Set<string>();
  let id = start;
  while (id && removed.has(id) && !seen.has(id)) {
    seen.add(id);
    id = byId.get(id)?.parentId ?? null;
  }
  return id && !removed.has(id) ? id : null;
}

/**
 * Claves que hay que desplegar en «Compartidos conmigo» o «Espacios de trabajo»
 * para ver `portfolioId`. La raíz del compartido se abre con el id del elemento;
 * las carpetas de dentro, con `shareId:portfolioId`. La propia raíz no lleva
 * la segunda clave: sus hijos ya se ven al abrir el elemento.
 */
export function sharedExpandKeys(input: {
  shareId: string;
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[];
  rootId: string | null;
  portfolioId: string | null;
}): string[] {
  const keys = [input.shareId];
  const byId = new Map(input.portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const seen = new Set<string>();
  let id = input.portfolioId;
  while (id && id !== input.rootId && !seen.has(id)) {
    seen.add(id);
    keys.push(`${input.shareId}:${id}`);
    id = byId.get(id)?.parentId ?? null;
  }
  return keys;
}
