import { createFileRoute } from "@tanstack/react-router";
import { handleDav } from "@/server/dav/handle";

/** WebDAV handlers for personal and shared subtrees. */
export const Route = createFileRoute("/dav/$")({
  server: { handlers: { ANY: ({ request }) => handleDav(request) } },
});
