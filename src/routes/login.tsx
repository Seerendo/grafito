import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AccessGate } from "@/components/access/AccessGate";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  return (
    <AccessGate>
      <Navigate to="/" />
    </AccessGate>
  );
}
