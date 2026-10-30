import { create } from "zustand";

/**
 * Lo elegido en el directorio con Ctrl, Mayús o «Seleccionar» del clic derecho.
 * Vive fuera del sidebar para que el menú de la página de un portafolio pueda
 * sumar una fila sin abrirla.
 */
type DirectoryPick = {
  picked: string[];
  anchor: string | null;
  add: (key: string) => void;
  setPicked: (picked: string[] | ((current: string[]) => string[])) => void;
  setAnchor: (anchor: string | null) => void;
  clear: () => void;
};

export const useDirectoryPick = create<DirectoryPick>((set) => ({
  picked: [],
  anchor: null,
  add: (key) =>
    set((state) => ({
      picked: state.picked.includes(key) ? state.picked : [...state.picked, key],
      anchor: key,
    })),
  setPicked: (picked) => set((state) => ({ picked: typeof picked === "function" ? picked(state.picked) : picked })),
  setAnchor: (anchor) => set({ anchor }),
  clear: () => set({ picked: [], anchor: null }),
}));
