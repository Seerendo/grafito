import { create } from "zustand";

/** Texto de las celdas, para que la barra y la paleta encuentren una tabla sin abrirla. */
export const useTableIndex = create<{ text: Record<string, string> }>(() => ({ text: {} }));

export function rememberTableText(docId: string, text: string): void {
  useTableIndex.setState((state) => ({ text: { ...state.text, [docId]: text.slice(0, 4000) } }));
}
