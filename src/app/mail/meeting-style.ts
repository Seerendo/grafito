import type { CSSProperties } from "react";

/** How a meeting looks by this account's answer (Agenda and invitation cards). */

export type Answer = "ACCEPTED" | "TENTATIVE" | "DECLINED";

export const ANSWER_LABEL: Record<string, string> = {
  ACCEPTED: "Aceptada",
  TENTATIVE: "Quizás",
  DECLINED: "Rechazada",
  "NEEDS-ACTION": "Sin responder",
};

/** Colors of a guest's answer in lists (dots and badges). */
export const ANSWER_TONE: Record<string, string> = {
  ACCEPTED: "#16a34a",
  TENTATIVE: "#d97706",
  DECLINED: "#dc2626",
  "NEEDS-ACTION": "#6b7280",
};

export function eventStyle(mine: string, color: string): CSSProperties {
  if (mine === "DECLINED")
    return { borderLeft: `3px solid ${color}`, background: "transparent", opacity: 0.55 };
  if (mine === "TENTATIVE")
    return {
      borderLeft: `3px solid ${color}`,
      backgroundImage: `repeating-linear-gradient(135deg, ${color}33 0 6px, transparent 6px 12px)`,
    };
  if (mine === "NEEDS-ACTION")
    return {
      border: `1px dashed ${color}`,
      borderLeft: `3px dashed ${color}`,
      background: "transparent",
    };
  return { borderLeft: `3px solid ${color}`, background: `${color}26` };
}
