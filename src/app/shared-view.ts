import { create } from "zustand";
import type { SharedTree } from "@/server/share";

/**
 * Qué elemento compartido conmigo está abierto en la bóveda (solo lectura).
 * Mientras hay uno abierto, el área principal muestra el visor en lugar del
 * editor; abrir una nota propia o volver a la raíz lo cierra.
 */
type SharedViewState = {
  tree: SharedTree | null;
  docId: string | null;
  openShared: (tree: SharedTree, docId: string | null) => void;
  closeShared: () => void;
};

export const useSharedView = create<SharedViewState>((set) => ({
  tree: null,
  docId: null,
  openShared: (tree, docId) => set({ tree, docId }),
  closeShared: () => set({ tree: null, docId: null }),
}));
