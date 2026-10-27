import { createFileRoute } from "@tanstack/react-router";
import { AccessNoteScreen } from "@/components/access/AccessNote";

/** Nota secreta del correo de acceso (`/acceso#<token>`). No pasa por `AccessGate`. */
export const Route = createFileRoute("/acceso")({ component: AccessNoteScreen });
