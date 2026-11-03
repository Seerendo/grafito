import { create } from "zustand";

/** Indexed cell text lets search and the command palette find unopened tables. */
export const useTableIndex = create<{ text: Record<string, string> }>(() => ({ text: {} }));

export function rememberTableText(docId: string, text: string): void {
  useTableIndex.setState((state) => ({ text: { ...state.text, [docId]: text.slice(0, 4000) } }));
}
