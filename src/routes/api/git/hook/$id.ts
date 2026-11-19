import { createHmac, timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { apiError } from "@/server/api";
import { gitEnabled, readLink, runLink, startGitSync } from "@/server/git/sync";

/**
 * POST /api/git/hook/:id triggers immediate optional repository synchronization. GitHub signs
 * the body using X-Hub-Signature-256; GitLab sends X-Gitlab-Token. See docs/GIT.md.
 */

/** Push events are small; GitHub caps payloads at 25 MB, far above what a ping or push needs. */
const MAX_BODY = 1024 * 1024;

/** Read at most max bytes of the body, or null when it is longer (security finding GRAF-08). */
async function boundedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const Route = createFileRoute("/api/git/hook/$id")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        // Anonymous callers: find the link and a signature header before reading any body.
        const github = request.headers.get("x-hub-signature-256") ?? "";
        const gitlab = request.headers.get("x-gitlab-token") ?? "";
        if (!github && !gitlab) return apiError(401, "Firma no válida.");
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        const link = await readLink(sql, params.id);
        if (!link || !(await gitEnabled(sql))) return apiError(404, "Ese enlace no existe.");
        const body = await boundedText(request, MAX_BODY);
        if (body === null) return apiError(413, "El aviso es demasiado grande.");
        const expected = `sha256=${createHmac("sha256", link.hook_secret).update(body).digest("hex")}`;
        const valid =
          (github && same(github, expected)) || (gitlab && same(gitlab, link.hook_secret));
        if (!valid) return apiError(401, "Firma no válida.");
        await sql`update git_link set pending = true where id = ${link.id}`;
        startGitSync();
        void runLink(sql, link.id);
        return new Response(null, { status: 202 });
      },
    },
  },
});
