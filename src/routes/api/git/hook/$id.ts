import { createHmac, timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { apiError } from "@/server/api";
import { gitEnabled, readLink, runLink, startGitSync } from "@/server/git/sync";

/**
 * `POST /api/git/hook/:id`: webhook opcional del repositorio enlazado, para
 * traer los cambios en cuanto se suben en vez de esperar a la siguiente vuelta.
 * GitHub firma el cuerpo con el secreto (`X-Hub-Signature-256`); GitLab lo
 * manda tal cual (`X-Gitlab-Token`). Ver `docs/GIT.md`.
 */

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const Route = createFileRoute("/api/git/hook/$id")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const body = await request.text();
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        const link = await readLink(sql, params.id);
        if (!link || !(await gitEnabled(sql))) return apiError(404, "Ese enlace no existe.");
        const github = request.headers.get("x-hub-signature-256") ?? "";
        const gitlab = request.headers.get("x-gitlab-token") ?? "";
        const expected = `sha256=${createHmac("sha256", link.hook_secret).update(body).digest("hex")}`;
        const valid = (github && same(github, expected)) || (gitlab && same(gitlab, link.hook_secret));
        if (!valid) return apiError(401, "Firma no válida.");
        await sql`update git_link set pending = true where id = ${link.id}`;
        startGitSync();
        void runLink(sql, link.id);
        return new Response(null, { status: 202 });
      },
    },
  },
});
