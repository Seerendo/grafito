import { createFileRoute } from "@tanstack/react-router";
import { MailScreen } from "@/components/mail/MailScreen";

export const Route = createFileRoute("/correo")({ component: MailScreen });
