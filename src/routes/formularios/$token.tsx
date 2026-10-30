import { createFileRoute } from "@tanstack/react-router";
import { AccessGate } from "@/components/access/AccessGate";
import { InvitedFormScreen } from "@/components/vault/TableForm";

/** Formulario enviado a una persona o a una organización. Pide sesión. */
export const Route = createFileRoute("/formularios/$token")({
  component: InvitedForm,
});

function InvitedForm() {
  const { token } = Route.useParams();
  return (
    <AccessGate>
      <InvitedFormScreen token={token} />
    </AccessGate>
  );
}
