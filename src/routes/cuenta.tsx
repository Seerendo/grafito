import { createFileRoute } from "@tanstack/react-router";
import { AccountScreen } from "@/components/account/AccountScreen";

export const Route = createFileRoute("/cuenta")({ component: AccountScreen });
