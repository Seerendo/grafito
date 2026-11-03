import { create } from "zustand";

/**
 * Directory selection via Ctrl, Shift or the context menu. State lives outside the sidebar so
 * portfolio-page menus can select rows without opening them.
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
  setPicked: (picked) =>
    set((state) => ({ picked: typeof picked === "function" ? picked(state.picked) : picked })),
  setAnchor: (anchor) => set({ anchor }),
  clear: () => set({ picked: [], anchor: null }),
}));
