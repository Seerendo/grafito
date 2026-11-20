import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { recordAudit, requestIp } from "@/server/audit";
import { abortUpload, deleteBlob, finishUpload, maxUploadBytes } from "@/server/blobs";
import { blockUnsafeBlob } from "@/server/clamav";
import { checkSpace } from "@/server/space";
import { importIdOf, logEvent, since } from "@/server/telemetry";
import { mayUpload, uploadTarget } from "@/server/upload-target";
import { registerImportedDoc, VaultError } from "@/server/vault";

/**
 * POST /api/files/uploads/complete finishes or aborts an upload; see uploads.ts. With `doc`
 * (personal destinations), the document that holds the file is stored in the same request once
 * the antivirus passed it: a 200 means the file is in storage and on the server, so it can be
 * opened right away. If storing the document fails, the object is removed and the error says so.
 */

const id = z.string().min(1).max(80);

const finish = z.object({
  key: z.string().min(1).max(200),
  uploadId: z.string().min(1).max(1000),
  parts: z
    .array(z.object({ part: z.number().int().min(1).max(10_000), etag: z.string().max(200) }))
    .max(10_000)
    .default([]),
  abort: z.boolean().optional(),
  portfolioId: id.nullable().optional(),
  shareId: id.nullable().optional(),
  doc: z
    .object({
      id,
      title: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      mime: z.string().max(120),
      createdAt: z.number().int().min(0),
      actor: z.string().max(80),
    })
    .optional(),
});

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function completeUpload(request: Request): Promise<Response> {
  const started = performance.now();
  const importId = importIdOf(request);
  let stage = "auth";
  try {
    const { sql, userId, profile } = await apiCaller(request);
    requirePermission(profile, PERMISSION.filesUpload, "Tu rol no permite subir archivos.");
    const body = finish.safeParse(await readJson(request));
    if (!body.success) return apiError(400, "Se espera { key, uploadId, parts }.");
    if (body.data.doc && body.data.shareId)
      return apiError(400, "Un archivo compartido se guarda con su propia llamada.");
    if (!(await mayUpload(sql, userId, body.data.key, body.data.shareId ?? null)))
      return apiError(403, "Esa subida no es tuya.");
    if (body.data.abort) {
      await abortUpload(sql, body.data.key, body.data.uploadId);
      return json({ ok: true });
    }
    stage = "storage";
    const size = await finishUpload(sql, body.data.key, body.data.uploadId, body.data.parts);
    const max = maxUploadBytes();
    if (size > max) {
      await deleteBlob(sql, body.data.key);
      return apiError(413, `El archivo supera el límite de ${megabytes(max)}.`);
    }
    // Check actual size because the initial declared size may differ.
    const target = await uploadTarget(sql, userId, body.data);
    const full =
      typeof target === "string"
        ? target
        : await checkSpace(sql, { ...target, uploaderId: userId, bytes: size });
    if (full) {
      await deleteBlob(sql, body.data.key);
      return apiError(413, full);
    }
    stage = "scan";
    const scanStart = performance.now();
    const blocked = await blockUnsafeBlob(sql, body.data.key);
    const scanMs = since(scanStart);
    const actorName = profile.loginName || profile.displayName;
    if (blocked) {
      await recordAudit(sql, {
        actorId: userId,
        actorName,
        action: "virus",
        outcome: "denied",
        area: "Archivos",
        target: body.data.key,
        detail: blocked.detail || blocked.message,
        ip: requestIp(request),
      }).catch((error) => console.error("No se pudo anotar el rechazo del antivirus.", error));
      logEvent("upload.refused", { importId, status: blocked.status, size, scanMs });
      return apiError(blocked.status, blocked.message);
    }
    let registered = null;
    const input = body.data.doc;
    if (input) {
      stage = "register";
      const now = Date.now();
      try {
        registered = await registerImportedDoc(sql, userId, {
          id: input.id,
          title: input.title,
          kind: "file",
          portfolioId: body.data.portfolioId ?? null,
          content: "",
          file: {
            name: input.name,
            mime: input.mime || "application/octet-stream",
            key: body.data.key,
            size,
          },
          links: [],
          pinned: false,
          createdAt: Math.min(input.createdAt, now),
          updatedAt: now,
          createdBy: input.actor || actorName,
          updatedBy: input.actor || actorName,
        });
      } catch (error) {
        await deleteBlob(sql, body.data.key);
        throw error;
      }
      // The same document sent again (a retried request): keep the object it already holds.
      if (!registered.created && registered.doc.file?.key !== body.data.key)
        await deleteBlob(sql, body.data.key);
    }
    await recordAudit(sql, {
      actorId: userId,
      actorName,
      action: "upload",
      outcome: "ok",
      area: "Archivos",
      target: body.data.key,
      detail: "Sube un archivo",
      ip: requestIp(request),
    }).catch((error) => console.error("No se pudo anotar la subida.", error));
    logEvent("upload.complete", {
      importId,
      size,
      scanMs,
      ms: since(started),
      registered: Boolean(registered),
      again: registered ? !registered.created : undefined,
    });
    return json(
      registered
        ? {
            key: registered.doc.file?.key ?? body.data.key,
            size,
            doc: registered.doc,
            revision: registered.revision,
          }
        : { key: body.data.key, size },
    );
  } catch (error) {
    if (error instanceof Response || error instanceof VaultError) {
      if (error instanceof VaultError)
        logEvent("upload.failed", { importId, stage, ms: since(started), status: error.status });
      return failure(error);
    }
    logEvent("upload.failed", {
      importId,
      stage,
      ms: since(started),
      status: 502,
      error: error instanceof Error ? error.name : "error",
    });
    console.error("[upload]", stage, error);
    // Said per stage, so a failed file tells storage apart from the document that holds it.
    return apiError(
      502,
      stage === "register"
        ? "No se pudo guardar el documento de este archivo."
        : stage === "scan"
          ? "No se pudo analizar el archivo con el antivirus."
          : "El almacenamiento de archivos no pudo guardar la subida.",
    );
  }
}

export const Route = createFileRoute("/api/files/uploads/complete")({
  server: { handlers: { POST: ({ request }) => completeUpload(request) } },
});
