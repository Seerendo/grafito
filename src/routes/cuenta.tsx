import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old address of the Account: now /account (sections in English). */
const SECTIONS: Record<string, string> = {
  perfil: "profile",
  correo: "email",
  buzones: "mailboxes",
  preferencias: "preferences",
  contrasena: "password",
  api: "api",
};

export const Route = createFileRoute("/cuenta")({
  beforeLoad: ({ search }) => {
    const asked = (search as { seccion?: unknown }).seccion;
    const section = typeof asked === "string" ? SECTIONS[asked] : undefined;
    throw redirect({ to: "/account", search: section ? { section } : {}, replace: true });
  },
});
