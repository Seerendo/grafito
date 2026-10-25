import { createFileRoute } from "@tanstack/react-router";
import { AccessGate } from "@/components/access/AccessGate";
import { VaultApp } from "@/components/vault/VaultApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <AccessGate>
      <VaultApp />
    </AccessGate>
  );
}
