import { createFileRoute } from "@tanstack/react-router";
import { readOfficeToken } from "@/server/office";
import { getDoc } from "@/server/vault";

/**
 * WOPI `CheckFileInfo`: lo pide el editor de Office (Collabora) al abrir un
 * documento. El acceso va en `access_token` (ficha firmada por Grafito).
 */
export const Route = createFileRoute("/wopi/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const token = readOfficeToken(request, params.id);
        if (!token) return new Response("Unauthorized", { status: 401 });
        const { getSql } = await import("@/lib/db");
        const doc = await getDoc(await getSql(), token.o, params.id);
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
