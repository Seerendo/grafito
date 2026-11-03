import { createFileRoute } from "@tanstack/react-router";
import { handleDav } from "@/server/dav/handle";

/** WebDAV root; handleDav dispatches PROPFIND, PUT and other methods. */
export const Route = createFileRoute("/dav/")({
  server: { handlers: { ANY: ({ request }) => handleDav(request) } },
});
