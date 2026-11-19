import { createFileRoute } from "@tanstack/react-router";
import { officeTokenStillGranted, readOfficeToken } from "@/server/office";
import { getDoc } from "@/server/vault";

/** WOPI CheckFileInfo requested by Collabora on opening, authorized by Grafito's signed access_token. */
export const Route = createFileRoute("/wopi/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const token = readOfficeToken(request, params.id);
        if (!token) return new Response("Unauthorized", { status: 401 });
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        if (!(await officeTokenStillGranted(sql, token)))
          return new Response("Access revoked", { status: 403 });
        const doc = await getDoc(sql, token.o, params.id);
        if (!doc?.file) return new Response("Not found", { status: 404 });
        return Response.json(
          {
            BaseFileName: doc.file.name,
            Size: doc.file.size ?? 0,
            OwnerId: token.o,
            UserId: token.u,
            UserFriendlyName: token.n,
            Version: doc.file.key ?? String(doc.updatedAt),
            LastModifiedTime: new Date(doc.updatedAt).toISOString(),
            UserCanWrite: token.w,
            ReadOnly: !token.w,
            SupportsUpdate: token.w,
            SupportsLocks: false,
            UserCanNotWriteRelative: true,
            UserCanRename: false,
            DisableExport: false,
            DisablePrint: false,
            PostMessageOrigin: token.p,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
