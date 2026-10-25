import { createFileRoute } from "@tanstack/react-router";
import { PublicShareScreen } from "@/components/share/ShareScreens";

/** Vista pública de un elemento compartido por enlace. No pasa por `AccessGate`. */
export const Route = createFileRoute("/p/$token")({ component: PublicShare });

function PublicShare() {
  const { token } = Route.useParams();
  return <PublicShareScreen token={token} />;
}
