import { create } from "zustand";
import type { SharedTree } from "@/server/share";

/**
 * Currently open shared item or workspace. It replaces the editor with a viewer until an owned
 * note or vault root is opened. With no docId, show portfolioId or the shared root, including
 * children, documents and recent items.
 */
type SharedViewState = {
  tree: SharedTree | null;
  docId: string | null;
  portfolioId: string | null;
  /** Open document text used by the vault outline panel. */
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
