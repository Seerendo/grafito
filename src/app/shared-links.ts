import { useEffect } from "react";
import { create } from "zustand";
import { sharedWithMe } from "@/server/share.functions";
import { fetchSharedTree } from "@/app/shared-open";
import type { SharedTree } from "@/server/share";
import type { Document, ManualLink, Portfolio } from "@/domain/vault/types";
import { useVault } from "@/app/vault/store";
import { useSharedView } from "@/app/shared-view";

/**
 * Vínculos hacia lo compartido conmigo (una nota, un archivo o un portafolio
 * de otra persona). El destino se lee del elemento compartido (`shareId`); si
 * el servidor dice que ya no tengo acceso, o el destino ya no está en lo
 * compartido, el vínculo se quita (`pruneShareLinks`). Un fallo de red no
 * quita nada: se vuelve a intentar más tarde.
 */

/** Cada cuánto se vuelve a mirar un elemento compartido. */
const FRESH_MS = 2 * 60_000;

type Entry = { tree: SharedTree | null; at: number };

type State = {
  trees: Record<string, Entry>;
  loading: Set<string>;
};

export const useSharedTrees = create<State>(() => ({ trees: {}, loading: new Set() }));

/** Lee (o vuelve a leer) un elemento compartido. `null`: sin acceso. Lanza si falla la red. */
export async function loadSharedTree(shareId: string, force = false): Promise<SharedTree | null> {
  const known = useSharedTrees.getState().trees[shareId];
  if (!force && known && Date.now() - known.at < FRESH_MS) return known.tree;
  const tree = await fetchSharedTree(shareId);
  useSharedTrees.setState((state) => ({ trees: { ...state.trees, [shareId]: { tree, at: Date.now() } } }));
  return tree;
}

/** Lo que se ve de un elemento compartido: sus documentos y portafolios, por id. */
function contentIds(tree: SharedTree): Set<string> {
  return new Set([...tree.documents.map((document) => document.id), ...tree.portfolios.map((portfolio) => portfolio.id)]);
}

/** Los `shareId` a los que apuntan los vínculos de la bóveda. */
function linkedShares(): string[] {
  const { documents, portfolios } = useVault.getState();
  const ids = new Set<string>();
  const collect = (links: ManualLink[] | undefined) => links?.forEach((link) => link.shareId && ids.add(link.shareId));
  documents.forEach((document) => collect(document.links));
  portfolios.forEach((portfolio) => collect(portfolio.links));
  return [...ids];
}

/** Mira cada elemento compartido vinculado y quita los vínculos que ya no se ven. */
export async function checkSharedLinks(force = false): Promise<void> {
  for (const shareId of linkedShares()) {
    let tree: SharedTree | null;
    try {
      tree = await loadSharedTree(shareId, force);
    } catch {
      continue;
    }
    useVault.getState().pruneShareLinks(shareId, tree ? contentIds(tree) : null);
  }
}

/** Mantiene al día los destinos compartidos de los vínculos mientras la bóveda está abierta. */
export function useSharedLinkCheck(): void {
  const owner = useVault((state) => state.owner);
  const hydrated = useVault((state) => state.hydrated);
  useEffect(() => {
    if (!owner || !hydrated) return;
    void checkSharedLinks();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkSharedLinks();
    }, FRESH_MS);
    return () => window.clearInterval(timer);
  }, [owner, hydrated]);
}

/** Un destino compartido: su título, tipo y elemento (para abrirlo), o `null` si no se ve. */
export function sharedTarget(
  trees: Record<string, Entry>,
  link: Pick<ManualLink, "shareId" | "targetId" | "target">,
): { title: string; kind: "markdown" | "file" | "portfolio"; tree: SharedTree; ownerName: string } | null {
  const tree = link.shareId ? trees[link.shareId]?.tree : null;
  if (!tree) return null;
  if (link.target === "portfolio") {
    const portfolio = tree.portfolios.find((item) => item.id === link.targetId);
    return portfolio ? { title: portfolio.name, kind: "portfolio", tree, ownerName: tree.share.ownerName } : null;
  }
  const document = tree.documents.find((item) => item.id === link.targetId);
  return document ? { title: document.title, kind: document.kind, tree, ownerName: tree.share.ownerName } : null;
}

/** Todo lo que se puede elegir como destino compartido (para el diálogo de vincular). */
export async function sharedCandidates(): Promise<
  { shareId: string; targetId: string; target?: "portfolio"; title: string; kind: "markdown" | "file" | "portfolio"; ownerName: string }[]
> {
  const shares = await sharedWithMe().catch(() => []);
  const out: Awaited<ReturnType<typeof sharedCandidates>> = [];
  for (const share of shares) {
    const tree = await loadSharedTree(share.id).catch(() => null);
    if (!tree) continue;
    for (const portfolio of tree.portfolios) {
      out.push({ shareId: share.id, targetId: portfolio.id, target: "portfolio", title: portfolio.name, kind: "portfolio", ownerName: tree.share.ownerName });
    }
    for (const document of tree.documents) {
      out.push({ shareId: share.id, targetId: document.id, title: document.title, kind: document.kind, ownerName: tree.share.ownerName });
    }
  }
  return out;
}

/**
 * El destino de un vínculo: una nota o archivo propio (sin `open`: se abre
 * como siempre), un portafolio propio (abre su página) o algo compartido
 * conmigo (abre su visor). `null` si ya no está.
 */
export function resolveLink(
  link: ManualLink,
  documents: Document[],
  portfolios: Portfolio[],
  trees: Record<string, Entry>,
): { id: string; title: string; open?: () => void } | null {
  if (link.shareId) {
    const found = sharedTarget(trees, link);
    if (!found) return null;
    return {
      id: link.targetId,
      title: `${found.title} · ${found.ownerName}`,
      open: () => useSharedView.getState().openShared(found.tree, found.kind === "portfolio" ? null : link.targetId),
    };
  }
  if (link.target === "portfolio") {
    const portfolio = portfolios.find((item) => item.id === link.targetId);
    return portfolio ? { id: portfolio.id, title: portfolio.name, open: () => useVault.getState().openPortfolio(portfolio.id) } : null;
  }
  const found = documents.find((item) => item.id === link.targetId);
  return found ? { id: found.id, title: found.title } : null;
}
