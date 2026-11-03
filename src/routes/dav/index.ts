import { createFileRoute } from "@tanstack/react-router";
import { handleDav } from "@/server/dav/handle";

/** WebDAV en `/dav` y `/dav/`. El método real (PROPFIND, PUT, …) lo resuelve `handleDav`. */
export const Route = createFileRoute("/dav/")({
  server: { handlers: { ANY: ({ request }) => handleDav(request) } },
});
