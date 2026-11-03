import { createFileRoute } from "@tanstack/react-router";
import { PublicFormScreen } from "@/components/vault/TableForm";

/** Public table form bypassing sign-in. */
export const Route = createFileRoute("/f/$token")({
  component: PublicForm,
});

function PublicForm() {
  const { token } = Route.useParams();
  return <PublicFormScreen token={token} />;
}
