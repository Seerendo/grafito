import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old address of «Compartidos conmigo»: now /shared. */
export const Route = createFileRoute("/compartidos/")({
  beforeLoad: () => {
    throw redirect({ to: "/shared", replace: true });
  },
});
