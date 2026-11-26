import { createFileRoute } from "@tanstack/react-router";
import { AccessNoteScreen } from "@/components/access/AccessNote";

/** One-time access-email note at /access#<token>, bypassing AccessGate. */
export const Route = createFileRoute("/access")({ component: AccessNoteScreen });
