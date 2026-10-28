import { create } from "zustand";
import { useEffect } from "react";
import { addDocComment, docComments, removeDocComment } from "@/server/comments.functions";
import type { TextAnchor } from "@/domain/vault/anchor";

/**
 * Comentarios de cada documento abierto, compartidos entre el panel de
 * Comentarios y el visor de PDF (las notas sobre una frase se resaltan en la
 * página). Cada documento se identifica por `docId` y, en lo compartido
 * conmigo, por `shareId`.
 */

export type DocComment = { id: string; author: string; body: string; at: number; mine: boolean; anchor: TextAnchor | null };

/** Nota que ya traía el propio PDF (de otro lector de PDF): solo se lee. */
export type PdfNote = { id: string; page: number; author: string; body: string; at: number | null };

/** Adónde ir en el PDF: una frase (`exact`) o solo la página. */
export type PdfFocus = { docId: string; page: number; exact?: string; at: number };

type Entry = { comments: DocComment[] | null; isOwner: boolean };

type State = {
  docs: Record<string, Entry>;
  pdfNotes: Record<string, PdfNote[]>;
  focus: PdfFocus | null;
  setPdfNotes: (docId: string, notes: PdfNote[]) => void;
  focusPdf: (docId: string, page: number, exact?: string) => void;
};

export const useComments = create<State>((set) => ({
  docs: {},
  pdfNotes: {},
  focus: null,
  setPdfNotes: (docId, notes) => set((state) => ({ pdfNotes: { ...state.pdfNotes, [docId]: notes } })),
  focusPdf: (docId, page, exact) => set({ focus: { docId, page, exact, at: Date.now() } }),
}));

export function commentKey(docId: string, shareId?: string): string {
  return `${shareId ?? ""}:${docId}`;
}

const scope = (docId: string, shareId?: string) => ({ docId, ...(shareId ? { shareId } : {}) });

export async function loadComments(docId: string, shareId?: string): Promise<void> {
  const key = commentKey(docId, shareId);
  try {
    const result = await docComments({ data: scope(docId, shareId) });
    useComments.setState((state) => ({ docs: { ...state.docs, [key]: { comments: result.comments, isOwner: result.isOwner } } }));
  } catch {
    useComments.setState((state) => {
      const current = state.docs[key];
      return { docs: { ...state.docs, [key]: { comments: current?.comments ?? [], isOwner: current?.isOwner ?? false } } };
    });
  }
}

/** Devuelve el error a mostrar, o `null` si se guardó. */
export async function sendComment(docId: string, shareId: string | undefined, body: string, anchor?: TextAnchor): Promise<string | null> {
  try {
    const result = await addDocComment({ data: { ...scope(docId, shareId), body, ...(anchor ? { anchor } : {}) } });
    if (!result.ok) return result.error;
    await loadComments(docId, shareId);
    return null;
  } catch {
    return "No se pudo enviar.";
  }
}

export async function deleteComment(docId: string, shareId: string | undefined, id: string): Promise<void> {
  const key = commentKey(docId, shareId);
  useComments.setState((state) => {
    const current = state.docs[key];
    if (!current?.comments) return state;
    return { docs: { ...state.docs, [key]: { ...current, comments: current.comments.filter((comment) => comment.id !== id) } } };
  });
  try {
    await removeDocComment({ data: { ...scope(docId, shareId), id } });
  } finally {
    void loadComments(docId, shareId);
  }
}

/** Cada cuánto se vuelven a leer mientras están a la vista. */
const REFRESH_MS = 20_000;

/** Los comentarios de un documento, leídos al montarse y cada poco mientras se ven. */
export function useDocComments(docId: string, shareId?: string): Entry {
  const entry = useComments((state) => state.docs[commentKey(docId, shareId)]);
  useEffect(() => {
    void loadComments(docId, shareId);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadComments(docId, shareId);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [docId, shareId]);
  return entry ?? { comments: null, isOwner: false };
}
