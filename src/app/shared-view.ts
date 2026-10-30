import { create } from "zustand";
import type { SharedTree } from "@/server/share";

/**
 * Qué elemento compartido conmigo (o espacio de trabajo) está abierto en la
 * bóveda. Mientras hay uno abierto, el área principal muestra el visor en
 * lugar del editor; abrir una nota propia o volver a la raíz lo cierra. Sin
 * documento (`docId` nulo), se ve la página de un portafolio de lo compartido
 * (`portfolioId`, o el compartido si es nulo): sus portafolios, sus documentos
 * y los recientes.
 */
type SharedViewState = {
  tree: SharedTree | null;
  docId: string | null;
  portfolioId: string | null;
  /** Texto del documento abierto, para el esquema del panel de la bóveda. */
  body: { id: string; content: string } | null;
  openShared: (tree: SharedTree, docId: string | null) => void;
  openSharedPortfolio: (tree: SharedTree, portfolioId: string | null) => void;
  setBody: (body: { id: string; content: string } | null) => void;
  closeShared: () => void;
};

export const useSharedView = create<SharedViewState>((set) => ({
  tree: null,
  docId: null,
  portfolioId: null,
  body: null,
  openShared: (tree, docId) => set({ tree, docId, portfolioId: null }),
  openSharedPortfolio: (tree, portfolioId) => set({ tree, docId: null, portfolioId, body: null }),
  setBody: (body) => set({ body }),
  closeShared: () => set({ tree: null, docId: null, portfolioId: null, body: null }),
}));
