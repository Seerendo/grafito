import { create } from "zustand";

/**
 * Short notices that float in a corner and fade by themselves (sent, draft saved, meeting
 * scheduled…). Only for outcomes worth telling; errors that need an action stay where they
 * happened.
 */

export type Toast = { id: number; text: string; tone: "ok" | "danger" };

const SHOWN_MS = 4000;
let next = 0;

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

export function toast(text: string, tone: Toast["tone"] = "ok"): void {
  const id = ++next;
  useToasts.setState((state) => ({ toasts: [...state.toasts.slice(-3), { id, text, tone }] }));
  setTimeout(() => {
    useToasts.setState((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  }, SHOWN_MS);
}
