import { create } from "zustand";

/**
 * Si la papelera ocupa el área principal de la bóveda. Abrir una nota, volver
 * a la raíz o abrir algo compartido la cierra.
 */
export const useTrashView = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
