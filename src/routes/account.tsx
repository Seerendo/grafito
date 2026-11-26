import { createFileRoute } from "@tanstack/react-router";
import { AccountScreen } from "@/components/account/AccountScreen";

export const Route = createFileRoute("/account")({
  component: AccountScreen,
  validateSearch: (search: Record<string, unknown>): { section?: string } =>
    typeof search.section === "string" ? { section: search.section } : {},
});
