import { createFileRoute } from "@tanstack/react-router";
import { AccessGate } from "@/components/access/AccessGate";
import { SharedWithMeScreen } from "@/components/share/ShareScreens";

export const Route = createFileRoute("/shared/")({ component: SharedWithMe });

function SharedWithMe() {
  return (
    <AccessGate>
      <SharedWithMeScreen />
    </AccessGate>
  );
}
