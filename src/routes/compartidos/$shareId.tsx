import { createFileRoute } from "@tanstack/react-router";
import { AccessGate } from "@/components/access/AccessGate";
import { SharedItemScreen } from "@/components/share/ShareScreens";

export const Route = createFileRoute("/compartidos/$shareId")({ component: SharedItem });

function SharedItem() {
  const { shareId } = Route.useParams();
  return (
    <AccessGate>
      <SharedItemScreen shareId={shareId} />
    </AccessGate>
  );
}
