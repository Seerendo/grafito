import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import {
  canRequestSignatures,
  decideSignature,
  listSignatures,
  pendingSignatures,
  placeSignatureBox,
  removeSignatureBox,
  requestSignatures,
  signPdfBox,
  signatureAudience,
  signatureOwner,
} from "@/server/signature";

/**
 * Readers see signature tracking; editors request signatures; only requested recipients may
 * sign or decline.
 */

const id = z.string().min(1).max(80);
const target = z.object({ docId: id, shareId: id.optional() });

async function context(userId: string, docId: string, shareId?: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const ownerId = allows(profile, PERMISSION.notesRead)
    ? await signatureOwner(sql, userId, docId, shareId)
    : null;
  const canRequest = ownerId
    ? await canRequestSignatures(sql, userId, ownerId, docId, shareId)
    : false;
  return { sql, profile, ownerId, canRequest };
}

export const signatureState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, ownerId, canRequest } = await context(auth.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, canRequest: false, rows: [] };
    const rows = await listSignatures(sql, ownerId, data.docId);
    return {
      ok: true as const,
      canRequest,
      rows: rows.map((row) => ({ ...row, mine: row.signerId === auth.userId })),
    };
  });

/** Eligible recipients already have document access, including its owner; never list all users. */
export const signaturePeople = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, ownerId, canRequest } = await context(auth.userId, data.docId, data.shareId);
    if (!ownerId || !canRequest) return [];
    return signatureAudience(sql, ownerId, data.docId, auth.userId);
  });

export const askSignatures = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    target.extend({ userIds: z.array(id).min(1).max(50) }).parse(input),
  )
  .handler(async ({ context: auth, data }) => {
    const { sql, profile, ownerId, canRequest } = await context(
      auth.userId,
      data.docId,
      data.shareId,
    );
    if (!ownerId || !canRequest)
      return { ok: false as const, error: "No puedes pedir firmas en este documento." };
    const { blocked } = await requestSignatures(sql, {
      ownerId,
      docId: data.docId,
      requesterId: auth.userId,
      requesterName: profile.displayName || profile.loginName || "Alguien",
      userIds: data.userIds,
    });
    return { ok: true as const, blocked };
  });

export const answerSignature = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        id,
        status: z.enum(["signed", "declined"]),
        note: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context: auth, data }) => {
    const sql = await requireLease(auth.userId);
    return decideSignature(sql, {
      userId: auth.userId,
      id: data.id,
      status: data.status,
      note: data.note ?? "",
    });
  });

const box = z.object({
  page: z.number().int().min(1).max(500),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

/** Owner or PDF editor places a recipient's rectangle. */
export const placeSignature = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.extend({ userId: id, box }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, profile, ownerId, canRequest } = await context(
      auth.userId,
      data.docId,
      data.shareId,
    );
    if (!ownerId || !canRequest)
      return { ok: false as const, error: "No puedes pedir firmas en este documento." };
    return placeSignatureBox(sql, {
      ownerId,
      docId: data.docId,
      requesterId: auth.userId,
      requesterName: profile.displayName || profile.loginName || "Alguien",
      signerId: data.userId,
      box: data.box,
    });
  });

/** Remove a pending rectangle; already stamped PDF images cannot be removed this way. */
export const removeSignature = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.extend({ signatureId: id }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, ownerId, canRequest } = await context(auth.userId, data.docId, data.shareId);
    if (!ownerId || !canRequest)
      return { ok: false as const, error: "No puedes pedir firmas en este documento." };
    return removeSignatureBox(sql, { ownerId, id: data.signatureId });
  });

/** Each recipient signs once using an image or .p12. Do not retain image, certificate or password. */
export const signPdf = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        id,
        image: z.string().min(32).max(700_000).optional(),
        p12: z.string().min(32).max(4_000_000).optional(),
        password: z.string().max(500).optional(),
      })
      .refine((value) => Boolean(value.image) !== Boolean(value.p12))
      .parse(input),
  )
  .handler(async ({ context: auth, data }) => {
    const sql = await requireLease(auth.userId);
    const profile = await readUserProfile(sql, auth.userId);
    if (!allows(profile, PERMISSION.notesRead))
      return { ok: false as const, error: "Ya no tienes acceso a este documento." };
    return signPdfBox(sql, {
      userId: auth.userId,
      userName: profile.displayName || profile.loginName || "Alguien",
      id: data.id,
      image: data.image,
      p12: data.p12,
      password: data.password,
    });
  });

export const myPendingSignatures = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context: auth }) => {
    const sql = await requireLease(auth.userId);
    const profile = await readUserProfile(sql, auth.userId);
    if (!allows(profile, PERMISSION.notesRead)) return [];
    return pendingSignatures(sql, auth.userId);
  });
