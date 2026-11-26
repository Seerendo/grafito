import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old address of the mail screen: now /mail. */
export const Route = createFileRoute("/correo")({
  beforeLoad: () => {
    throw redirect({ to: "/mail", replace: true });
  },
});
