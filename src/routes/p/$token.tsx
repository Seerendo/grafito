import { createFileRoute } from "@tanstack/react-router";
import { PublicShareScreen } from "@/components/share/ShareScreens";

/** Public shared-item view bypassing AccessGate. */
export const Route = createFileRoute("/p/$token")({ component: PublicShare });

function PublicShare() {
  const { token } = Route.useParams();
  return <PublicShareScreen token={token} />;
}
