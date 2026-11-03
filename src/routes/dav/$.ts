import { createFileRoute } from "@tanstack/react-router";
import { handleDav } from "@/server/dav/handle";

/** WebDAV del resto del árbol (`/dav/Personal/…`, `/dav/Compartidos/…`). */
export const Route = createFileRoute("/dav/$")({
  server: { handlers: { ANY: ({ request }) => handleDav(request) } },
});
