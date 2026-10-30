import { createFileRoute } from "@tanstack/react-router";
import { PublicFormScreen } from "@/components/vault/TableForm";

/** Formulario público de una tabla. No pasa por el ingreso. */
export const Route = createFileRoute("/f/$token")({
  component: PublicForm,
});

function PublicForm() {
  const { token } = Route.useParams();
  return <PublicFormScreen token={token} />;
}
