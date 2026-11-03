import { createFileRoute } from "@tanstack/react-router";
import { getBlob, maxUploadBytes, putBlob } from "@/server/blobs";
import { newFileKey } from "@/server/files";
import { readOfficeToken } from "@/server/office";
import { editableTarget } from "@/server/share";
import { getDoc, replaceFile } from "@/server/vault";

/**
 * WOPI GetFile and PutFile let Office read and save files. Every save creates a new object and
 * history version; preserve the previous object for restoration.
 */
export const Route = createFileRoute("/wopi/files/$id/contents")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const token = readOfficeToken(request, params.id);
        if (!token) return new Response("Unauthorized", { status: 401 });
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        const doc = await getDoc(sql, token.o, params.id);
        const blob = doc?.file?.key ? await getBlob(sql, doc.file.key) : null;
        if (!doc?.file || !blob) return new Response("Not found", { status: 404 });
        return new Response(blob.body as BodyInit, {
          headers: {
            "content-type": "application/octet-stream",
            "x-wopi-itemversion": doc.file.key ?? "",
            ...blob.headers,
          },
        });
      },
      POST: async ({ request, params }) => {
        const token = readOfficeToken(request, params.id);
        if (!token) return new Response("Unauthorized", { status: 401 });
        if (!token.w) return new Response("Read only", { status: 403 });
        const override = request.headers.get("x-wopi-override")?.toUpperCase();
        if (override && override !== "PUT") return new Response("Not implemented", { status: 501 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > maxUploadBytes()) return new Response("Too large", { status: 413 });
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        // Recheck shared edit permission on every save.
        if (token.s && !(await editableTarget(sql, token.u, token.s, params.id))) {
          return new Response("Access revoked", { status: 403 });
        }
        const doc = await getDoc(sql, token.o, params.id);
        if (!doc?.file?.key) return new Response("Not found", { status: 404 });
        // The editor sends its opened-file timestamp. Reject overwriting a newer/restored version; Collabora offers reload or explicit overwrite without that header.
        const opened =
          request.headers.get("x-cool-wopi-timestamp") ??
          request.headers.get("x-lool-wopi-timestamp");
        if (opened && Date.parse(opened) !== doc.updatedAt) {
          return Response.json({ COOLStatusCode: 1010 }, { status: 409 });
        }
        const key = newFileKey(token.o);
        await putBlob(sql, key, bytes, doc.file.mime);
        // Group editor autosaves in history; explicit saves remain separate.
        const autosave =
          (request.headers.get("x-cool-wopi-isautosave") ??
            request.headers.get("x-lool-wopi-isautosave")) === "true";
        const saved = await replaceFile(sql, token.o, params.id, {
          key,
          size: bytes.byteLength,
          actor: token.n,
          actorId: token.u,
          autosave,
        });
        return Response.json(
          { LastModifiedTime: new Date(saved.updatedAt).toISOString() },
          { headers: { "x-wopi-itemversion": key } },
        );
      },
    },
  },
});
