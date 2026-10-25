import { createFileRoute } from "@tanstack/react-router";
import { AdminScreen } from "@/components/admin/AdminScreen";

export const Route = createFileRoute("/admin")({ component: AdminScreen });
