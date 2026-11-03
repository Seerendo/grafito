import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { allows } from "@/server/profile";
import { apiCaller, apiError, failure } from "@/server/api";
import { sharedTreeForUser } from "@/server/share";
import { treeHttpResponse } from "@/server/tree-response";

/**
 * GET /api/shared/:id/tree returns a packed shared/workspace tree. ETags allow bodyless 304
 * responses, compression is cached per version, and fresh=1 bypasses short-lived cached views.
 */
export const Route = createFileRoute("/api/shared/$id/tree")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const caller = await apiCaller(request);
          const tree = await sharedTreeForUser(
            caller.sql,
            caller.userId,
            params.id,
            allows(caller.profile, PERMISSION.filesDownload),
            new URL(request.url).searchParams.get("fresh") === "1",
          );
          if (!tree) return apiError(404, "Ya no está compartido contigo.");
          return treeHttpResponse(request, tree);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
