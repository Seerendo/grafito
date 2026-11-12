import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  edgesWithin,
  graphOnline,
  graphReady,
  incomingLinks,
  treeOf,
  vaultEdges,
  visibleIds,
} from "@/server/graph/read";
import { readGraphStatus, requestGraphRebuild, startGraphSync } from "@/server/graph/sync";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { packAnalysis, packEdges, type PackedEdges } from "@/domain/graph-pack";
import { readAnalysis } from "@/server/graph/analysis";
import type { IncomingLink } from "@/server/graph/read";
import { publicTokenOwner, publicTreeFor, sharedTreeForUser, shareForUser } from "@/server/share";

/**
 * The graph and mentions, read from Grafeno. Off answers mean the graph is paused, Grafeno is
 * not configured or not answering: the interface hides the graph and the rest goes on.
 *
 * Every function here is a POST: a GET server function carries the caller's session token in
 * its URL, where proxies and access logs keep it.
 */

const EMPTY: PackedEdges = { ids: "", shares: "", edges: "" };

const OFF = { ok: false as const, off: true as const };

/** A query Grafeno refused keeps the graph on; only an engine that does not answer turns it off. */
function failed(error: unknown) {
  return error instanceof Error && "status" in error
    ? { ok: false as const, off: false as const }
    : OFF;
}

async function caller(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, profile };
}

/** Whether this person can use the graph now. */
export const graphState = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    startGraphSync();
    if (!allows(profile, PERMISSION.graphView)) return { available: false };
    return { available: await graphOnline(sql) };
  });

const scope = z.object({ shareId: z.string().min(1).max(80).optional() });

/** Links of the person's vault, or of a share they can open. */
export const graphEdges = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => scope.parse(input ?? {}))
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, PERMISSION.graphView) || !(await graphOnline(sql))) return OFF;
    try {
      if (!data.shareId) {
        return {
          ok: true as const,
          edges: packEdges(await vaultEdges(sql, context.userId)),
          analysis: packAnalysis(await readAnalysis(sql, context.userId)),
          ready: await graphReady(sql, context.userId),
        };
      }
      const share = await shareForUser(sql, context.userId, data.shareId);
      const response = share
        ? await sharedTreeForUser(sql, context.userId, data.shareId, false)
        : null;
      if (!share || !response) return { ok: false as const, off: false as const };
      const visible = visibleIds(treeOf(response));
      return {
        ok: true as const,
        edges: packEdges(await edgesWithin(sql, share.ownerId, visible)),
        // Only what the reader sees: a share does not reveal the rest of its owner's vault.
        analysis: packAnalysis(await readAnalysis(sql, share.ownerId), (id) => visible.has(id)),
        ready: await graphReady(sql, share.ownerId),
      };
    } catch (error) {
      return failed(error);
    }
  });

const target = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["doc", "portfolio"]).default("doc"),
  shareId: z.string().min(1).max(80).optional(),
});

/** What links to one document or portfolio, among what the person can open. */
export const graphIncoming = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, PERMISSION.graphView) || !(await graphOnline(sql))) return OFF;
    try {
      if (!data.shareId) {
        return {
          ok: true as const,
          items: await incomingLinks(sql, context.userId, { kind: data.kind, id: data.id }),
        };
      }
      const share = await shareForUser(sql, context.userId, data.shareId);
      const response = share
        ? await sharedTreeForUser(sql, context.userId, data.shareId, false)
        : null;
      if (!share || !response) return { ok: false as const, off: false as const };
      const visible = visibleIds(treeOf(response));
      return {
        ok: true as const,
        items: await incomingLinks(sql, share.ownerId, { kind: data.kind, id: data.id }, visible),
      };
    } catch (error) {
      return failed(error);
    }
  });

const publicScope = z.object({
  token: z.string().min(8).max(200),
  id: z.string().min(1).max(200).optional(),
});

/** The graph of a public link, or what points at one of its documents. */
export const publicGraph = createServerFn({ method: "POST" })
  .validator((input: unknown) => publicScope.parse(input))
  .handler(async ({ data }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    if (!(await graphOnline(sql))) return OFF;
    try {
      const owner = await publicTokenOwner(sql, data.token);
      const response = owner ? await publicTreeFor(sql, data.token) : null;
      if (!owner || !response) return { ok: false as const, off: false as const };
      const visible = visibleIds(treeOf(response));
      if (data.id) {
        return {
          ok: true as const,
          edges: EMPTY,
          analysis: packAnalysis(null),
          items: await incomingLinks(sql, owner, { kind: "doc", id: data.id }, visible),
          ready: true,
        };
      }
      return {
        ok: true as const,
        edges: packEdges(await edgesWithin(sql, owner, visible)),
        analysis: packAnalysis(await readAnalysis(sql, owner), (id) => visible.has(id)),
        items: [] as IncomingLink[],
        ready: await graphReady(sql, owner),
      };
    } catch (error) {
      return failed(error);
    }
  });

/** Grafeno and the copy of the vaults, for Administración → Monitorización. */
export const graphStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "monitor.view")) return { ok: false as const };
    startGraphSync();
    return { ok: true as const, ...(await readGraphStatus(sql)) };
  });

/** Copy every vault into Grafeno again. */
export const rebuildGraph = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "monitor.view")) return { ok: false as const };
    await requestGraphRebuild(sql);
    startGraphSync();
    return { ok: true as const };
  });
