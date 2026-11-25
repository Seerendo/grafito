import { createFileRoute } from "@tanstack/react-router";
import { AccountScreen } from "@/components/account/AccountScreen";

export const Route = createFileRoute("/cuenta")({
  component: AccountScreen,
  validateSearch: (search: Record<string, unknown>): { seccion?: string } =>
    typeof search.seccion === "string" ? { seccion: search.seccion } : {},
});
