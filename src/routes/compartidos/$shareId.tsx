import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old address of a shared item: now /shared/$shareId. */
export const Route = createFileRoute("/compartidos/$shareId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/shared/$shareId", params: { shareId: params.shareId }, replace: true });
  },
});
