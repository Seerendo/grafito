import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import type { Sql } from "@/lib/db";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { editableTarget, grantedDocOwner } from "@/server/share";
import { getDoc } from "@/server/vault";
import { isTextAnchor, type TextAnchor } from "@/domain/vault/anchor";
import { addComment, deleteComment, listComments, MAX_COMMENT } from "@/server/comments";

/**
 * Owners and shared readers may view/add comments without editing the document. Only the author
 * or document owner may delete a comment.
 */

const id = z.string().min(1).max(80);
const target = z.object({ docId: id, shareId: id.optional() });

/** Document owner when userId may read it, otherwise null. */
async function ownerFor(
  sql: Sql,
  userId: string,
  docId: string,
  shareId?: string,
): Promise<string | null> {
  if (!shareId) return (await getDoc(sql, userId, docId)) ? userId : null;
  return (
    (await editableTarget(sql, userId, shareId, docId))?.ownerId ??
    (await grantedDocOwner(sql, userId, shareId, docId))
  );
}

async function context(userId: string, docId: string, shareId?: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const ownerId = allows(profile, PERMISSION.notesRead)
    ? await ownerFor(sql, userId, docId, shareId)
    : null;
  return { sql, profile, ownerId };
}

export const docComments = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, ownerId } = await context(auth.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, comments: [], isOwner: false };
    const comments = await listComments(sql, ownerId, data.docId);
    return {
      ok: true as const,
      isOwner: ownerId === auth.userId,
      comments: comments.map(({ authorId, ...comment }) => ({
        ...comment,
        mine: authorId === auth.userId,
      })),
    };
  });

export const addDocComment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    target
      .extend({
        body: z.string().trim().min(1).max(MAX_COMMENT),
        // Comment anchored to a PDF phrase.
        anchor: z.custom<TextAnchor>(isTextAnchor).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context: auth, data }) => {
    const { sql, profile, ownerId } = await context(auth.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, error: "Ya no tienes acceso a este documento." };
    await addComment(sql, {
      ownerId,
      docId: data.docId,
      authorId: auth.userId,
      authorName: profile.displayName || profile.loginName || "Alguien",
      body: data.body,
      anchor: data.anchor ?? null,
    });
    return { ok: true as const };
  });

export const removeDocComment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.extend({ id }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, ownerId } = await context(auth.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const };
    await deleteComment(sql, { ownerId, docId: data.docId, id: data.id, userId: auth.userId });
    return { ok: true as const };
  });
