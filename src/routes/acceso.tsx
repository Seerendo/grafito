import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old address of the one-time access note: now /access (the #token travels with it). */
export const Route = createFileRoute("/acceso")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/access", hash: location.hash, replace: true });
  },
});
