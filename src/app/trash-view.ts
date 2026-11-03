import { create } from "zustand";

/** Whether trash fills the vault's main area. Opening a note, vault root or shared item closes it. */
export const useTrashView = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
