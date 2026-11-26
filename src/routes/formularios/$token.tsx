import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old address of an invitation form: now /forms/$token. */
export const Route = createFileRoute("/formularios/$token")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/forms/$token", params: { token: params.token }, replace: true });
  },
});
